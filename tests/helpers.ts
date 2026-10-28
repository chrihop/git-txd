import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Coordinator } from "../src/coordinator.js";

const exec = promisify(execFile);
/** Real Git invocation confined to disposable fixture repositories. */
export const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  return result.stdout.trim();
};
/** Temporary worktree and seeded bare remote; no live external service. */
export const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "git-txd-test-"));
  const repo = join(root, "work");
  const remote = join(root, "remote.git");
  const stateDir = join(root, "state");
  await mkdir(repo);
  await git(root, "init", "--bare", remote);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "a.txt"), "a\n");
  await writeFile(join(repo, "b.txt"), "b\n");
  await git(repo, "add", "a.txt", "b.txt");
  await git(repo, "commit", "-m", "Seed");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "origin", "main");
  const base = await git(repo, "rev-parse", "HEAD");
  const config = {
    repo,
    stateDir,
    branch: "main",
    remote: "origin",
    port: 0,
    pushRetries: 0,
    gitTimeoutMs: 10000,
    pushTimeoutMs: 10000,
    reconciliationTimeoutMs: 10000,
  };
  return {
    root,
    repo,
    remote,
    stateDir,
    base,
    config,
    open: () => Coordinator.open(config),
    remove: () => rm(root, { recursive: true, force: true }),
  };
};
/** Construct a canonical request for one added path. */
export const request = (id: string, path = `${id}.txt`) => ({
  request_id: id,
  files: [{ path, operation: "add" as const }],
  message: `Add ${id}`,
});
