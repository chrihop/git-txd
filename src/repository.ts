import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, openSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import fsExt from "fs-ext";
import { type Config } from "./config.js";
import {
  type Request,
  type StoredRequest,
  TxdError,
  validatePathSyntax,
} from "./model.js";
import { GitRunner, MAX_SNAPSHOT_BYTES } from "./runner.js";

/** Canonical checkout, kernel singleton lock, and safe Git operations. */
export class Repository {
  private constructor(
    readonly config: Config,
    readonly git: GitRunner,
    readonly identity: string,
    readonly stateDir: string,
    private readonly lockFd: number,
  ) {}

  static async open(config: Config): Promise<Repository> {
    const root = await realpath(config.repo);
    const git = new GitRunner(root, config.gitTimeoutMs);
    const top = await realpath(
      await git.text(["rev-parse", "--show-toplevel"]),
    );
    if (top !== root)
      throw new TxdError(
        "REPO_ROOT_REQUIRED",
        "Configure the canonical worktree root.",
      );
    await git.text(["check-ref-format", `refs/heads/${config.branch}`]);
    const common = await realpath(
      resolve(root, await git.text(["rev-parse", "--git-common-dir"])),
    );
    const identity = createHash("sha256")
      .update(`${root}\0${common}`)
      .digest("hex");
    const registry = join(common, "git-txd", identity);
    await privateDirectory(registry);
    const lockFd = openSync(
      join(registry, "owner.lock"),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fsExt.flockSync(lockFd, "exnb");
    } catch {
      closeSync(lockFd);
      throw new TxdError(
        "ALREADY_RUNNING",
        "Another daemon or its surviving Git child owns this worktree.",
      );
    }
    try {
      const stateDir = resolve(config.stateDir ?? join(registry, "state"));
      const relativeState = relative(root, stateDir);
      if (
        !isAbsolute(relativeState) &&
        !relativeState.startsWith("../") &&
        !relativeState.startsWith(".git/")
      ) {
        throw new TxdError(
          "UNSAFE_STATE_DIR",
          "Keep service state outside working files or within Git metadata.",
        );
      }
      await privateDirectory(stateDir);
      const canonicalState = await realpath(stateDir);
      const pointer = join(registry, "state-location");
      let existing: string | undefined;
      try {
        existing = await readFile(pointer, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing && existing !== canonicalState) {
        throw new TxdError(
          "STATE_LOCATION_CONFLICT",
          "This worktree already has a durable ledger in another state directory.",
        );
      }
      if (!existing)
        await writeFile(pointer, canonicalState, { mode: 0o600, flag: "wx" });
      const hooks = join(canonicalState, "empty-hooks");
      await privateDirectory(hooks);
      if ((await readdir(hooks)).length)
        throw new TxdError(
          "HOOKS_POLICY",
          "The configured hooks directory must remain empty.",
        );
      git.hooksPath = hooks;
      git.lockFd = lockFd;
      return new Repository(
        { ...config, repo: root },
        git,
        identity,
        canonicalState,
        lockFd,
      );
    } catch (error) {
      closeSync(lockFd);
      throw error;
    }
  }

  close(): void {
    closeSync(this.lockFd);
  }
  head(): Promise<string> {
    return this.git.text(["rev-parse", "--verify", "HEAD"]);
  }

  async assertBoundary(
    expectedHead?: string,
    allowStaged = false,
  ): Promise<string> {
    const indexLock = resolve(
      this.config.repo,
      await this.git.text(["rev-parse", "--git-path", "index.lock"]),
    );
    await this.waitForIndexLock(indexLock);
    const branch = await this.git.text(["symbolic-ref", "-q", "HEAD"]);
    if (branch !== `refs/heads/${this.config.branch}`)
      throw new TxdError(
        "BRANCH_CHANGED",
        "HEAD is not the configured branch.",
      );
    const head = await this.head();
    if (expectedHead && head !== expectedHead)
      throw new TxdError(
        "HEAD_CHANGED",
        "Local HEAD changed outside the coordinator.",
      );
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      const path = resolve(
        this.config.repo,
        await this.git.text(["rev-parse", "--git-path", name]),
      );
      try {
        await lstat(path);
        throw new TxdError(
          "GIT_OPERATION_IN_PROGRESS",
          "Another Git operation or index lock requires operator attention.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if ((await this.git.text(["ls-files", "--unmerged", "-z"])).length) {
      throw new TxdError(
        "UNMERGED_INDEX",
        "Resolve the unmerged index in a maintenance window.",
      );
    }
    if (!allowStaged && (await this.stagedPaths()).length)
      throw new TxdError(
        "DIRTY_INDEX",
        "Unexpected staged content; preserve it and inspect manually.",
      );
    return head;
  }

  async tracked(paths: string[]): Promise<Map<string, string>> {
    // Query only immediate entries along requested paths. A recursive whole
    // tree can exceed the subprocess bound in a large corpus; querying parent
    // pathspecs recursively would also enumerate unrelated descendants.
    const children = new Map<string, Set<string>>();
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (!children.has(parent)) children.set(parent, new Set());
        children.get(parent)!.add(parts[i]!);
      }
    }
    const tracked = new Map<string, string>();
    for (const parent of [...children.keys()].sort(
      (a, b) => a.length - b.length,
    )) {
      if (parent && tracked.get(parent) !== "040000") continue;
      const names = [...children.get(parent)!];
      for (const batch of pathBatches(names)) {
        const result = await this.git.run([
          "--literal-pathspecs",
          "ls-tree",
          "-z",
          parent ? `HEAD:${parent}` : "HEAD",
          "--",
          ...batch,
        ]);
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.aborted ||
          result.ioError
        )
          throw new TxdError(
            "TREE_READ_FAILED",
            "Cannot inspect the selected committed paths.",
          );
        for (const entry of splitNul(result.stdout)) {
          const name = entry.slice(entry.indexOf("\t") + 1);
          tracked.set(parent ? `${parent}/${name}` : name, entry.slice(0, 6));
        }
      }
    }
    return tracked;
  }

  async validateFiles(
    files: Request["files"],
  ): Promise<Record<string, number>> {
    const sizes: Record<string, number> = Object.create(null);
    validatePathSyntax(files);
    const tracked = await this.tracked(files.map((file) => file.path));
    for (const file of files) {
      const mode = tracked.get(file.path);
      if (mode && !["100644", "100755"].includes(mode))
        throw new TxdError(
          "UNSUPPORTED_FILE",
          "Symlinks, submodules, and special modes are unsupported.",
        );
      if ((file.operation === "add") === Boolean(mode))
        throw new TxdError(
          "OPERATION_MISMATCH",
          "Add requires an untracked file; modify/delete require a tracked file.",
        );
      let path = this.config.repo;
      const parts = file.path.split("/");
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        let stat;
        try {
          stat = await lstat(path);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" &&
            file.operation === "delete"
          )
            break;
          throw new TxdError(
            "FILE_MISSING",
            "Requested file or parent does not exist.",
          );
        }
        const leaf = index === parts.length - 1;
        if (
          stat.isSymbolicLink() ||
          (leaf ? !stat.isFile() : !stat.isDirectory()) ||
          tracked.get(parts.slice(0, index + 1).join("/")) === "160000"
        ) {
          throw new TxdError(
            "UNSUPPORTED_FILE",
            "Paths must resolve through ordinary directories to regular files.",
          );
        }
        if ((await realpath(path)) !== path)
          throw new TxdError(
            "PATH_ALIAS",
            "Use the canonical filename and case.",
          );
        if (leaf && file.operation === "delete")
          throw new TxdError(
            "OPERATION_MISMATCH",
            "Delete requires the working file to be absent.",
          );
        if (leaf && file.operation !== "delete") {
          if (
            !Number.isSafeInteger(stat.size) ||
            stat.size > MAX_SNAPSHOT_BYTES
          )
            throw new TxdError(
              "SNAPSHOT_SIZE_LIMIT",
              "Requested file exceeds the bounded snapshot size.",
            );
          sizes[file.path] = stat.size;
          if (
            (file.sha256 &&
              (await hashFile(path, stat.size, this.config.gitTimeoutMs)) !==
                file.sha256) ||
            (file.mode &&
              (stat.mode & 0o111 ? "100755" : "100644") !== file.mode)
          )
            throw new TxdError(
              "SNAPSHOT_CHANGED",
              "Requested file differs from its admitted content or mode.",
            );
        }
      }
    }
    return sizes;
  }

  async describe(paths: string[]): Promise<Request["files"]> {
    validatePathSyntax(paths.map((path) => ({ path, operation: "modify" })));
    const tracked = await this.tracked(paths);
    const files: Request["files"] = [];
    for (const path of paths) {
      let exists = true;
      try {
        await lstat(join(this.config.repo, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
        else throw error;
      }
      let operation: Request["files"][number]["operation"] = "add";
      if (tracked.has(path)) operation = exists ? "modify" : "delete";
      files.push({ path, operation });
    }
    return files;
  }

  async stagedPaths(): Promise<string[]> {
    const result = await this.git.run([
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      "--",
    ]);
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.ioError
    )
      throw new TxdError(
        "INDEX_READ_FAILED",
        "Cannot inspect the staging index.",
      );
    return splitNul(result.stdout);
  }

  async assertSubset(files: Request["files"], commit?: string): Promise<void> {
    let paths: string[];
    if (commit) {
      const result = await this.git.run([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-r",
        "-z",
        commit,
        "--",
      ]);
      if (
        result.code !== 0 ||
        result.timedOut ||
        result.aborted ||
        result.ioError
      )
        throw new TxdError(
          "COMMIT_READ_FAILED",
          "Cannot validate committed paths.",
        );
      paths = splitNul(result.stdout);
    } else paths = await this.stagedPaths();
    const allowed = new Set(files.map((file) => file.path));
    if (paths.some((path) => !allowed.has(path)))
      throw new TxdError(
        "UNEXPECTED_PATHS",
        "Index or commit contains paths outside this request.",
      );
    if (!commit) {
      for (const batch of pathBatches(paths)) {
        const entries = await this.git.text([
          "--literal-pathspecs",
          "ls-files",
          "--stage",
          "-z",
          "--",
          ...batch,
        ]);
        for (const entry of entries.split("\0")) {
          const tab = entry.indexOf("\t");
          if (
            allowed.has(entry.slice(tab + 1)) &&
            !["100644", "100755"].includes(entry.slice(0, 6))
          ) {
            throw new TxdError(
              "UNSUPPORTED_FILE",
              "Staged path has an unsupported file mode.",
            );
          }
        }
      }
    }
  }

  private async indexLocked(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async waitForIndexLock(
    path: string,
    deadline = Date.now() + Math.min(5000, this.config.gitTimeoutMs),
  ): Promise<void> {
    while (await this.indexLocked(path)) {
      if (Date.now() >= deadline)
        throw new TxdError(
          "GIT_OPERATION_IN_PROGRESS",
          "Git index lock remains occupied; operator attention required.",
        );
      await delay(50);
    }
  }

  async stage(files: Request["files"]): Promise<string> {
    const parent = await this.head();
    const indexLock = resolve(
      this.config.repo,
      await this.git.text(["rev-parse", "--git-path", "index.lock"]),
    );
    const deadline = Date.now() + Math.min(5000, this.config.gitTimeoutMs);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.git.text(
          [
            "--literal-pathspecs",
            "add",
            "-A",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { input: pathInput(files) },
        );
      } catch (error) {
        if (
          !(error instanceof TxdError) ||
          !["GIT_COMMAND_FAILED", "INDEX_LOCKED"].includes(error.code) ||
          attempt >= 2 ||
          Date.now() >= deadline ||
          (error.code !== "INDEX_LOCKED" &&
            !(await this.indexLocked(indexLock)))
        )
          throw error;
        await this.waitForIndexLock(indexLock, deadline);
        await this.assertBoundary(parent);
        await this.validateFiles(files);
      }
    }
  }

  async cleanRequestIndex(
    files: Request["files"],
    parent: string,
  ): Promise<void> {
    await this.assertBoundary(parent, true);
    await this.assertSubset(files);
    const staged = await this.stagedPaths();
    if (staged.length)
      await this.git.text(
        [
          "--literal-pathspecs",
          "restore",
          "--source=HEAD",
          "--staged",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        {
          input: pathInput(
            staged.map((path) => ({ path, operation: "modify" })),
          ),
        },
      );
    await this.assertBoundary(parent);
  }

  async commit(request: StoredRequest): Promise<void> {
    const parent = await this.head();
    const indexLock = resolve(
      this.config.repo,
      await this.git.text(["rev-parse", "--git-path", "index.lock"]),
    );
    const deadline = Date.now() + Math.min(5000, this.config.gitTimeoutMs);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.assertBoundary(parent, true);
        await this.assertSubset(request.files);
        await this.commitSnapshot(request);
        return;
      } catch (error) {
        if (
          !(error instanceof TxdError) ||
          error.code !== "INDEX_LOCKED" ||
          attempt >= 2 ||
          Date.now() >= deadline
        )
          throw error;
        await this.waitForIndexLock(indexLock, deadline);
      }
    }
  }

  private async commitSnapshot(request: StoredRequest): Promise<void> {
    await this.verifySnapshot(request.files, undefined, request.snapshot_sizes);
    const identity = request.author ?? this.config.committer;
    await this.git.text(
      ["-c", "commit.cleanup=verbatim", "commit", "--no-verify", "-F", "-"],
      {
        input: Buffer.from(
          `${request.message}\n\nGit-Tx-Id: ${request.request_id}\n`,
        ),
        env: {
          GIT_COMMITTER_NAME: this.config.committer.name,
          GIT_COMMITTER_EMAIL: this.config.committer.email,
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
        },
      },
    );
  }

  async verifyCommit(
    sha: string,
    parent: string,
    request: StoredRequest,
  ): Promise<void> {
    if (
      (await this.git.text(["rev-list", "--parents", "-n", "1", sha])) !==
      `${sha} ${parent}`
    ) {
      throw new TxdError(
        "UNEXPECTED_HISTORY",
        "Transaction commit does not have exactly the intended parent.",
      );
    }
    const message = await this.git.text(["show", "-s", "--format=%B", sha]);
    const trailers = message
      .split("\n")
      .filter((line) => /^Git-Tx-Id:/i.test(line));
    if (
      trailers.length !== 1 ||
      trailers[0] !== `Git-Tx-Id: ${request.request_id}`
    ) {
      throw new TxdError(
        "UNEXPECTED_COMMIT",
        "Commit transaction trailer does not match the durable request.",
      );
    }
    await this.assertSubset(request.files, sha);
    await this.verifySnapshot(request.files, sha, request.snapshot_sizes);
  }

  /** Check admitted bytes in the index and again in the durable commit. */
  private async verifySnapshot(
    files: Request["files"],
    sha?: string,
    sizes?: Record<string, number>,
  ): Promise<void> {
    for (const file of files) {
      if (file.operation === "delete") continue;
      if (file.sha256) {
        const expectedBytes = sizes?.[file.path];
        if (expectedBytes === undefined || !Number.isSafeInteger(expectedBytes))
          throw new TxdError(
            "SNAPSHOT_SIZE_MISSING",
            "No admitted snapshot size; preserve old in-flight work for the operator.",
          );
        const result = await this.git.hashBlob(
          ["show", `${sha ?? ""}:${file.path}`],
          expectedBytes,
        );
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.aborted ||
          result.outputExceeded ||
          result.ioError ||
          result.stdoutBytes !== expectedBytes ||
          result.stdoutSha256 !== file.sha256
        )
          throw new TxdError(
            "SNAPSHOT_CHANGED",
            "Staged or committed bytes differ from the admitted snapshot.",
          );
      }
      if (file.mode) {
        const entry = sha
          ? await this.git.text(["ls-tree", sha, "--", file.path])
          : await this.git.text(["ls-files", "--stage", "--", file.path]);
        if (!entry.startsWith(`${file.mode} `))
          throw new TxdError(
            "SNAPSHOT_CHANGED",
            "Staged or committed mode differs from the admitted snapshot.",
          );
      }
    }
  }

  async pushUrl(): Promise<string> {
    const urls = (
      await this.git.text([
        "remote",
        "get-url",
        "--push",
        "--all",
        this.config.remote,
      ])
    ).split("\n");
    if (urls.length !== 1)
      throw new TxdError("REMOTE_POLICY", "Exactly one push URL is required.");
    return urls[0]!;
  }

  async remoteTip(): Promise<string | null> {
    const url = await this.pushUrl();
    const output = await this.git.text(
      ["ls-remote", "--refs", "--", url, `refs/heads/${this.config.branch}`],
      { timeoutMs: this.config.reconciliationTimeoutMs },
    );
    if (!output) return null;
    const [sha, ref] = output.split(/\s+/);
    if (
      !sha ||
      !/^[a-f0-9]{40,64}$/.test(sha) ||
      ref !== `refs/heads/${this.config.branch}`
    )
      throw new TxdError(
        "REMOTE_INSPECTION_FAILED",
        "Unexpected remote ref response.",
      );
    return sha;
  }

  async push(sha: string): Promise<void> {
    await this.git.text(
      [
        "-c",
        "push.followTags=false",
        "-c",
        `remote.${this.config.remote}.mirror=false`,
        "push",
        "--porcelain",
        "--no-verify",
        this.config.remote,
        `${sha}:refs/heads/${this.config.branch}`,
      ],
      { timeoutMs: this.config.pushTimeoutMs },
    );
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git.run([
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    if (result.code > 1 || result.timedOut || result.aborted || result.ioError)
      throw new TxdError(
        "ANCESTRY_UNKNOWN",
        "Unable to determine remote ancestry.",
      );
    return result.code === 0;
  }

  async fetchRemoteTip(tip: string): Promise<void> {
    await this.git.text(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        await this.pushUrl(),
        `refs/heads/${this.config.branch}`,
      ],
      { timeoutMs: this.config.reconciliationTimeoutMs },
    );
    await this.git.text(["cat-file", "-e", `${tip}^{commit}`]);
  }
}

/** Bound argv bytes as well as entry count on macOS and Linux. */
function* pathBatches(paths: string[]): Generator<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (batch.length && (batch.length >= 128 || bytes + size > 16384)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length) yield batch;
}

const privateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new TxdError(
      "STATE_PERMISSIONS",
      "State directories must be ordinary directories with mode 0700.",
    );
};
const splitNul = (buffer: Buffer): string[] =>
  buffer.toString("utf8").split("\0").filter(Boolean);
const pathInput = (files: Request["files"]): Buffer =>
  Buffer.from(`${files.map((file) => file.path).join("\0")}\0`);

/** Stream a working preimage with exact length, a deadline and bounded memory. */
const hashFile = async (
  path: string,
  expectedBytes: number,
  timeoutMs: number,
): Promise<string> => {
  const hash = createHash("sha256");
  let size = 0;
  try {
    const input = createReadStream(path, {
      highWaterMark: 64 * 1024,
      signal: AbortSignal.timeout(timeoutMs),
    });
    for await (const chunk of input) {
      size += chunk.length;
      if (size > expectedBytes)
        throw new TxdError(
          "SNAPSHOT_CHANGED",
          "Working file length changed during admission.",
        );
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof TxdError) throw error;
    throw new TxdError(
      "SNAPSHOT_READ_FAILED",
      "Working snapshot could not be read within its bounds.",
    );
  }
  if (size !== expectedBytes)
    throw new TxdError(
      "SNAPSHOT_CHANGED",
      "Working file length changed during admission.",
    );
  return hash.digest("hex");
};
