import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import { TxdError } from "./model.js";

/** Structured tool result shape; additional diagnostics may be added compatibly. */
export const resultSchema = z.looseObject({
  request_id: z.string(),
  status: z.string(),
  durable_state: z.string(),
  commit_sha: z.string().nullable(),
  pushed: z.boolean(),
  remote: z.string(),
  branch: z.string(),
  repository_state: z.string(),
  queue_deadline_ms: z.number(),
  error_code: z.string().nullable(),
});
/** Queue observations do not reserve a position. */
export const queueSchema = z.looseObject({
  repository_state: z.string(),
  pending_count: z.number(),
  ahead_if_submitted: z.number(),
  estimated_wait_sec: z.number(),
  active: z.unknown(),
  pending: z.array(z.unknown()),
});
/** Common backend interface used by direct HTTP tools and the stdio proxy. */
export interface Backend {
  commitAndPush(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  queue(): Record<string, unknown> | Promise<Record<string, unknown>>;
  status(
    id: string,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  wait(
    id: string,
    seconds?: number | null,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

/** Authenticated loopback client. It never opens a ledger or starts a Git worker. */
export class Client implements Backend {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new TxdError(
        "INVALID_ENDPOINT",
        "Client endpoint must be an HTTP loopback origin.",
      );
    }
  }

  static async fromFile(url: string, tokenFile: string): Promise<Client> {
    return new Client(url, (await readFile(tokenFile, "utf8")).trim());
  }

  async call(
    route: string,
    body: unknown = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(`/api/${route}`, this.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(3600000),
      redirect: "error",
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new TxdError(
        String(result.error_code ?? "API_ERROR"),
        String(result.error_message ?? "Daemon request failed."),
      );
    return result;
  }

  commitAndPush(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.call("commit", input, signal);
  }
  queue(): Promise<Record<string, unknown>> {
    return this.call("queue");
  }
  status(id: string): Promise<Record<string, unknown>> {
    return this.call("status", { request_id: id });
  }
  wait(
    id: string,
    seconds?: number | null,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.call(
      "wait",
      { request_id: id, wait_timeout_seconds: seconds ?? null },
      signal,
    );
  }
}
