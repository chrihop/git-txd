import { createHash } from "node:crypto";
import * as z from "zod/v4";

/** Validated, bounded transaction input shared by all transports. */
export const requestSchema = z.strictObject({
  request_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        operation: z.enum(["add", "modify", "delete"]),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        mode: z.enum(["100644", "100755"]).optional(),
      }),
    )
    .min(1)
    .max(1000),
  message: z
    .string()
    .min(1)
    .max(16384)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !value.includes("\0") &&
        !/^\s*Git-Tx-Id\s*:/im.test(value),
      "Empty message, NUL, or reserved Git-Tx-Id trailer",
    ),
  author: z
    .strictObject({
      name: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^\r\n<>\0]+$/),
      email: z.string().email().max(254),
    })
    .optional(),
  metadata: z
    .strictObject({
      agent_id: z.string().max(128).optional(),
      task_id: z.string().max(128).optional(),
    })
    .optional(),
  wait_timeout_seconds: z.number().min(0).max(3600).nullable().optional(),
});

/** Input for one logical, idempotent commit request. */
export type Request = z.infer<typeof requestSchema>;
/** Internal admission metadata persisted in the ledger, never accepted from callers. */
export type StoredRequest = Request & {
  snapshot_sizes?: Record<string, number>;
};
/** Durable states; a caller wait timeout is deliberately absent. */
export type Status =
  | "QUEUED"
  | "RUNNING_PRECOMMIT"
  | "LOCAL_COMMITTED"
  | "PUSHING"
  | "PUSH_PENDING"
  | "RECONCILING"
  | "RECONCILIATION_REQUIRED"
  | "SUCCEEDED"
  | "NO_CHANGES"
  | "PRECOMMIT_FAILED"
  | "QUEUE_EXPIRED"
  | "CANCELLED_QUEUED";
/** Repository service health. */
export type Health = "RECOVERING" | "READY" | "BUSY" | "PAUSED";
/** Durable transaction record. */
export interface Job {
  request_id: string;
  request_digest: string;
  enqueue_seq: number;
  payload_json: string;
  status: Status;
  accepted_at_ms: number;
  queue_deadline_ms: number;
  started_at_ms: number | null;
  expected_parent: string | null;
  commit_sha: string | null;
  remote_tip_sha: string | null;
  finished_at_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

/** Stable error code suitable for callers; never includes raw Git stderr. */
export class TxdError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TxdError";
  }
}

/** Whether a job has a definitive outcome. */
export const isTerminal = (status: Status): boolean =>
  [
    "SUCCEEDED",
    "NO_CHANGES",
    "PRECOMMIT_FAILED",
    "QUEUE_EXPIRED",
    "CANCELLED_QUEUED",
  ].includes(status);

/** Canonical digest excludes observation metadata and caller waiting policy. */
export const digestRequest = (request: Request, identity: string): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        identity,
        files: [...request.files].sort((a, b) =>
          a.path.localeCompare(b.path, "en"),
        ),
        message: request.message,
        author: request.author ?? null,
      }),
    )
    .digest("hex");

/** Reject ambiguous path syntax before accessing the filesystem. */
export const validatePathSyntax = (files: Request["files"]): void => {
  const seen = new Set<string>();
  for (const { path } of files) {
    const parts = path.split("/");
    if (
      /^[A-Za-z]:/.test(path) ||
      path.startsWith("/") ||
      /[\0\\*?\[\]]/.test(path) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      ) ||
      seen.has(path)
    ) {
      throw new TxdError(
        "INVALID_PATH",
        "Use unique, explicit relative file paths without traversal, globs, or Git metadata.",
      );
    }
    seen.add(path);
  }
};

const SAFE_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EIO",
  "ENOENT",
  "EINVAL",
  "ENOMEM",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "ESRCH",
  "EPIPE",
  "ABORT_ERR",
  "ERR_INVALID_ARG_TYPE",
  "ERR_OUT_OF_RANGE",
  "ERR_STREAM_PREMATURE_CLOSE",
  "SNAPSHOT_CHANGED",
  "SNAPSHOT_SIZE_MISSING",
  "SNAPSHOT_SIZE_LIMIT",
  "SNAPSHOT_READ_FAILED",
  "GIT_TERMINATION_FAILED",
  "GIT_CUSTODY_UNCONFIRMED",
  "GIT_CLOSE_UNOBSERVED",
  "GIT_ABORTED",
  "GIT_START_FAILED",
  "GIT_COMMAND_FAILED",
  "GIT_CONFIG_FAILED",
  "INDEX_LOCKED",
  "GIT_OPERATION_IN_PROGRESS",
  "UNEXPECTED_PATHS",
  "INDEX_READ_FAILED",
  "UNSUPPORTED_FILE",
]);
const SAFE_STAGES = new Set([
  "validate_files",
  "stage",
  "assert_subset",
  "staged_paths",
  "commit_snapshot",
  "push",
  "unknown",
]);
const ownValue = (value: unknown, key: string): unknown => {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
};
const ownCode = (error: unknown): string | null => {
  const value = ownValue(error, "code");
  return typeof value === "string" && SAFE_ERROR_CODES.has(value)
    ? value
    : null;
};
/** Sanitized journal diagnostic: no message, stack, arguments, URLs or arbitrary names. */
export interface ErrorDiagnostic {
  kind: string;
  code: string | null;
  stage: string;
  cause_code: string | null;
  custody?: {
    child_close_observed: boolean;
    lock_inherited: boolean;
    pid: number | null;
  };
}
/** Retain allowlisted type, errno, stage and observed child custody only. */
export const sanitizedError = (
  error: unknown,
  stage: string,
): ErrorDiagnostic => {
  let kind = "UnknownError";
  try {
    if (error instanceof TxdError) kind = "TxdError";
    else if (error instanceof TypeError) kind = "TypeError";
    else if (error instanceof RangeError) kind = "RangeError";
    else if (error instanceof SyntaxError) kind = "SyntaxError";
    else if (error instanceof Error) kind = "Error";
  } catch {
    /* Opaque proxies cannot contribute a trusted type. */
  }
  const result: ErrorDiagnostic = {
    kind,
    code: ownCode(error),
    stage: SAFE_STAGES.has(stage) ? stage : "unknown",
    cause_code: ownCode(ownValue(error, "cause")),
  };
  const custody = ownValue(error, "custody");
  const closed = ownValue(custody, "child_close_observed");
  const inherited = ownValue(custody, "lock_inherited");
  const pid = ownValue(custody, "pid");
  if (typeof closed === "boolean" && typeof inherited === "boolean")
    result.custody = {
      child_close_observed: closed,
      lock_inherited: inherited,
      pid:
        typeof pid === "number" &&
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        pid <= 2147483647
          ? pid
          : null,
    };
  return result;
};
