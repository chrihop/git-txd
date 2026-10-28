import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(project, "package.json"), "utf8"),
);
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const temporary = await mkdtemp(join(tmpdir(), "git-txd-package-"));
const worktree = join(temporary, "work");
const remote = join(temporary, "remote.git");
const state = join(temporary, "state");
const installation = join(temporary, "installation");
const configuration = join(temporary, "daemon.json");
const executable = join(installation, "node_modules", ".bin", "git-txd");
let daemon;
let endpoint;
let tokenFile;
const clients = [];

const command = (file, args, cwd = temporary) =>
  exec(file, args, {
    cwd,
    env: environment,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
const git = async (cwd, ...args) => {
  const result = await command(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "user.name=Package Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    cwd,
  );
  return result.stdout.trim();
};
const cli = async (args, expectedExit = 0) => {
  let result;
  try {
    result = await command(executable, [
      "--url",
      endpoint,
      "--token-file",
      tokenFile,
      "--json",
      ...args,
    ]);
    assert.equal(expectedExit, 0);
  } catch (error) {
    assert.equal(error.code, expectedExit, "Unexpected CLI exit status");
    result = error;
  }
  return JSON.parse(result.stdout);
};
const commit = (id, paths, message, expectedExit = 0) =>
  cli(
    [
      "commit",
      "--request-id",
      id,
      ...paths.flatMap((path) => ["--file", path]),
      "--message",
      message,
    ],
    expectedExit,
  );
const start = async () => {
  daemon = spawn(executable, ["start", "--config", configuration], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Startup timed out")),
      30000,
    );
    const failed = () => {
      clearTimeout(timeout);
      reject(new Error(`Daemon exited before readiness: ${stderr}`));
    };
    const onData = (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
      for (const line of stderr.split("\n")) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.event !== "DAEMON_READY") continue;
        clearTimeout(timeout);
        daemon.off("exit", failed);
        daemon.stderr.off("data", onData);
        daemon.stderr.resume();
        endpoint = record.url;
        tokenFile = record.token_file;
        resolve();
        break;
      }
    };
    daemon.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    daemon.once("exit", failed);
    daemon.stderr.on("data", onData);
  });
  assert.equal((await cli(["health"])).repository_state, "READY");
};
const stop = async () => {
  const exited = once(daemon, "exit", { signal: AbortSignal.timeout(30000) });
  assert.equal((await cli(["stop"])).status, "STOPPING");
  assert.deepEqual(await exited, [0, null]);
  daemon = undefined;
};
const connect = async (stdio = false) => {
  const client = new Client({ name: "package-fixture", version: "1" });
  clients.push(client);
  const transport = stdio
    ? new StdioClientTransport({
        command: executable,
        args: ["--url", endpoint, "--token-file", tokenFile, "mcp-stdio"],
        env: environment,
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
        requestInit: {
          headers: {
            authorization: `Bearer ${(await readFile(tokenFile, "utf8")).trim()}`,
          },
        },
      });
  await client.connect(transport);
  return client;
};
const tool = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
};
const disconnect = async () => {
  for (const client of clients.splice(0)) await client.close();
};

try {
  const packed = await command(
    "npm",
    ["pack", "--json", "--pack-destination", temporary],
    project,
  );
  const tarball = JSON.parse(packed.stdout)[0].filename;
  await command("npm", [
    "install",
    "--prefix",
    installation,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    join(temporary, tarball),
  ]);
  assert.equal(
    (await command(executable, ["--version"])).stdout.trim(),
    manifest.version,
  );
  await mkdir(worktree);
  await git(temporary, "init", "--bare", "--initial-branch=main", remote);
  await git(worktree, "init", "-b", "main");
  await writeFile(join(worktree, "foreign.txt"), "seed\n");
  await git(worktree, "add", "foreign.txt");
  await git(worktree, "commit", "-m", "Seed fixture");
  await git(worktree, "remote", "add", "origin", remote);
  await git(worktree, "push", "origin", "main");
  const base = await git(worktree, "rev-parse", "HEAD");
  await writeFile(
    configuration,
    JSON.stringify({
      repo: worktree,
      remote: "origin",
      branch: "main",
      stateDir: state,
      port: 0,
      pushRetries: 0,
    }),
  );
  await start();
  const ledger = await stat(join(state, "ledger.sqlite"));
  await writeFile(join(worktree, "foreign.txt"), "preserved concurrent edit\n");
  for (const name of ["first.txt", "second.txt"])
    await writeFile(join(worktree, name), name);
  const first = await commit(
    "package-cli",
    ["first.txt", "second.txt"],
    "Add owned files",
  );
  assert.equal(first.status, "SUCCEEDED");
  assert.equal(first.pushed, true);
  assert.equal(await git(remote, "rev-parse", "main"), first.commit_sha);
  assert.deepEqual(
    (
      await git(
        worktree,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        first.commit_sha,
      )
    ).split("\n"),
    ["first.txt", "second.txt"],
  );
  const http = await connect();
  const stdio = await connect(true);
  assert.equal(
    (await tool(http, "git_queue_info", {})).repository_state,
    "READY",
  );
  assert.equal(
    (await tool(stdio, "git_transaction_status", { request_id: "package-cli" }))
      .commit_sha,
    first.commit_sha,
  );
  await writeFile(join(worktree, "mcp.txt"), "MCP payload\n");
  const request = {
    request_id: "package-mcp",
    files: [{ path: "mcp.txt", operation: "add" }],
    message: "Add MCP file",
  };
  const mcp = await tool(http, "git_commit_and_push", request);
  assert.equal(mcp.status, "SUCCEEDED");
  assert.equal(
    (await tool(stdio, "git_commit_and_push", request)).commit_sha,
    mcp.commit_sha,
  );
  await disconnect();
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(worktree, "recover.txt"), "recover original commit\n");
  const pending = await commit(
    "package-recovery",
    ["recover.txt"],
    "Add recoverable file",
    4,
  );
  assert.equal(pending.status, "RECONCILIATION_REQUIRED");
  assert.equal(pending.repository_state, "PAUSED");
  assert.equal(await git(worktree, "rev-parse", "HEAD"), pending.commit_sha);
  assert.equal(await git(remote, "rev-parse", "main"), mcp.commit_sha);
  await stop();
  await rm(hook);
  await start();
  const recovered = await commit(
    "package-recovery",
    ["recover.txt"],
    "Add recoverable file",
  );
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.pushed, true);
  assert.equal(recovered.commit_sha, pending.commit_sha);
  assert.equal((await stat(join(state, "ledger.sqlite"))).ino, ledger.ino);
  assert.equal(
    (
      await commit(
        "package-cli",
        ["first.txt", "second.txt"],
        "Add owned files",
      )
    ).commit_sha,
    first.commit_sha,
  );
  const restarted = await connect(true);
  assert.equal(
    (await tool(restarted, "git_commit_and_push", request)).commit_sha,
    mcp.commit_sha,
  );
  assert.equal(
    await git(worktree, "rev-list", "--count", `${base}..HEAD`),
    "3",
  );
  assert.equal(await git(remote, "rev-parse", "main"), recovered.commit_sha);
  assert.equal(await git(worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(
    await readFile(join(worktree, "foreign.txt"), "utf8"),
    "preserved concurrent edit\n",
  );
  await disconnect();
  await stop();
  console.log(
    JSON.stringify({
      result: "passed",
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      production_install: true,
      cli_http_and_stdio: true,
      original_ledger_and_sha_recovered: true,
      commits: 3,
      unrelated_edit_preserved: true,
    }),
  );
} finally {
  await disconnect();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGKILL");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
