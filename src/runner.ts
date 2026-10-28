import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { TxdError } from "./model.js";

/** Maximum admitted blob length; ordinary captured output has its own limit. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
/** Observed custody of a Git child, without command or credential output. */
export interface GitCustody {
  pid: number | null;
  child_close_observed: boolean;
  lock_inherited: boolean;
  exit_code?: number | null;
  signal_code?: string | null;
}
/** Subprocess result without credential-bearing output in diagnostics. */
export interface GitResult {
  code: number;
  stdout: Buffer;
  timedOut: boolean;
  aborted: boolean;
  outputExceeded: boolean;
  ioError: boolean;
  stdoutBytes: number;
  stdoutSha256: string | undefined;
  custody: GitCustody;
  indexLocked?: boolean;
}
/** Bounded command execution options shared by captured and hash-only reads. */
export interface GitRunOptions {
  input?: Buffer;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
type ExecutionOptions = GitRunOptions & { hashBytes?: number };
type CustodyError = TxdError & { custody: GitCustody };

/** Fixed-policy Git runner; arguments never pass through a shell. */
export class GitRunner {
  lockFd: number | undefined;
  readonly children = new Set<ChildProcess>();
  custodyFailure: CustodyError | undefined;
  hooksPath = "/dev/null";
  constructor(
    readonly repo: string,
    readonly timeoutMs = 120000,
  ) {}

  /** Hash a Git blob without retaining stdout, bounded by its admitted size. */
  async hashBlob(
    args: string[],
    expectedBytes: number,
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 ||
      expectedBytes > MAX_SNAPSHOT_BYTES
    )
      throw new TxdError(
        "SNAPSHOT_SIZE_LIMIT",
        "Snapshot size is absent or outside the bounded blob policy.",
      );
    return this.run(args, { ...options, hashBytes: expectedBytes });
  }

  async run(
    args: string[],
    options: ExecutionOptions = {},
  ): Promise<GitResult> {
    this.assertCustody();
    if (
      options.hashBytes !== undefined &&
      (!Number.isSafeInteger(options.hashBytes) ||
        options.hashBytes < 0 ||
        options.hashBytes > MAX_SNAPSHOT_BYTES)
    )
      throw new TxdError(
        "SNAPSHOT_SIZE_LIMIT",
        "Snapshot size is outside the bounded blob policy.",
      );
    if (options.signal?.aborted)
      throw new TxdError(
        "GIT_ABORTED",
        "Git operation was cancelled before launch.",
      );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      LC_ALL: "C",
      ...options.env,
    });
    for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
    Object.assign(env, {
      no_proxy: "*",
      NO_PROXY: "*",
      GIT_PROXY_COMMAND: "",
      GIT_SSH_COMMAND:
        "ssh -o ProxyCommand=none -o ProxyJump=none -o ControlMaster=no -o ControlPath=none",
      GIT_SSH_VARIANT: "ssh",
    });
    const fixed = [
      "--no-optional-locks",
      "-c",
      `core.hooksPath=${this.hooksPath}`,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.splitIndex=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "color.ui=false",
      "-c",
      "http.proxy=",
    ];
    const proxies = await this.execute(
      [
        ...fixed,
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^(http|remote)\\..*\\.proxy$",
      ],
      env,
      {
        timeoutMs: Math.min(
          options.timeoutMs ?? this.timeoutMs,
          this.timeoutMs,
        ),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (proxies.aborted)
      throw new TxdError(
        "GIT_ABORTED",
        "Git operation was cancelled during configuration inspection.",
      );
    if (
      proxies.timedOut ||
      proxies.ioError ||
      (proxies.code !== 0 && proxies.code !== 1)
    )
      throw new TxdError(
        "GIT_CONFIG_FAILED",
        "Unable to inspect Git proxy configuration.",
      );
    const keys = [
      ...new Set(proxies.stdout.toString("utf8").split("\0")),
    ].filter(Boolean);
    env.GIT_CONFIG_COUNT = String(keys.length);
    keys.forEach((key, index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = "";
    });
    return this.execute([...fixed, ...args], env, options);
  }

  private assertCustody(): void {
    if (this.custodyFailure)
      throw Object.assign(
        new TxdError(
          "GIT_CUSTODY_UNCONFIRMED",
          "Owned Git custody is unresolved; operator reconciliation is required before another command.",
        ),
        { custody: this.custodyFailure.custody },
      );
  }

  private execute(
    args: string[],
    env: NodeJS.ProcessEnv,
    options: ExecutionOptions,
  ): Promise<GitResult> {
    this.assertCustody();
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.repo,
        env,
        detached: true,
        stdio: [
          "pipe",
          "pipe",
          "pipe",
          ...(this.lockFd === undefined ? [] : [this.lockFd]),
        ],
      });
      this.children.add(child);
      let timedOut = false;
      let aborted = false;
      let outputExceeded = false;
      let ioError = false;
      let killRequested = false;
      let terminationError: unknown;
      let terminationTimer: NodeJS.Timeout | undefined;
      let size = 0;
      const hash =
        options.hashBytes === undefined ? undefined : createHash("sha256");
      const outputLimit = options.hashBytes ?? 16 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let stderrTail = "";
      const custody = (closed: boolean): GitCustody => ({
        pid: child.pid ?? null,
        child_close_observed: closed,
        lock_inherited: this.lockFd !== undefined,
      });
      const terminationFailure = (closed: boolean): CustodyError => {
        const failure = Object.assign(
          new TxdError(
            "GIT_TERMINATION_FAILED",
            "Git termination could not be confirmed; preserve custody for the operator.",
          ),
          { cause: terminationError, custody: custody(closed) },
        );
        this.custodyFailure = failure;
        return failure;
      };
      const kill = (): void => {
        if (killRequested) return;
        killRequested = true;
        terminationTimer = setTimeout(() => {
          terminationError ??= new TxdError(
            "GIT_CLOSE_UNOBSERVED",
            "Owned child close was not observed within cleanup allowance.",
          );
          reject(terminationFailure(false));
        }, 2000);
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            terminationError = error;
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs ?? this.timeoutMs);
      const cancel = (): void => {
        aborted = true;
        kill();
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > outputLimit) {
          outputExceeded = true;
          timedOut = true;
          kill();
          return;
        }
        if (hash) hash.update(chunk);
        else chunks.push(chunk);
      });
      child.stdout!.on("error", () => {
        ioError = true;
        kill();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
      });
      child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          ioError = true;
          timedOut = true;
          kill();
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        reject(new TxdError("GIT_START_FAILED", "Unable to launch Git."));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        clearTimeout(terminationTimer);
        options.signal?.removeEventListener("abort", cancel);
        this.children.delete(child);
        if (terminationError) {
          reject(terminationFailure(true));
          return;
        }
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(chunks),
          timedOut,
          aborted,
          outputExceeded,
          ioError,
          stdoutBytes: size,
          stdoutSha256: hash?.digest("hex"),
          custody: { ...custody(true), exit_code: code, signal_code: signal },
          indexLocked: /index\.lock[^\n]*File exists/.test(stderrTail),
        });
      });
      child.stdin!.end(options.input);
    });
  }

  async text(args: string[], options: GitRunOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.code !== 0 && !result.timedOut && result.indexLocked)
      throw new TxdError(
        "INDEX_LOCKED",
        "Another process holds the Git index lock.",
      );
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.ioError
    )
      throw new TxdError(
        "GIT_COMMAND_FAILED",
        "Git command failed or exceeded its execution limit. Inspect repository state as the operator.",
      );
    return result.stdout.toString("utf8").trim();
  }
}
