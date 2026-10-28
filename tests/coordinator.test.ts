import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { GitRunner } from "../src/runner.js";
import { fixture, git, request } from "./helpers.js";

const resources: Array<{
  close?: () => Promise<void>;
  remove?: () => Promise<void>;
}> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.reverse()) {
    await resource.close?.();
    await resource.remove?.();
  }
  resources.length = 0;
});
const setup = async (overrides = {}) => {
  const f = await fixture();
  resources.push(f);
  const coordinator = await Coordinator.open({ ...f.config, ...overrides });
  resources.push(coordinator);
  return { ...f, coordinator };
};

describe("real Git scheduler", () => {
  it("leaves a persistent foreign index lock untouched and pauses", async () => {
    const f = await setup({ gitTimeoutMs: 1000 });
    await writeFile(join(f.repo, "locked.txt"), "selected\n");
    const indexLock = join(f.repo, ".git", "index.lock");
    await writeFile(indexLock, "foreign owner", { flag: "wx" });
    const result = await f.coordinator.commitAndPush(request("locked"));
    expect(result.repository_state).toBe("PAUSED");
    expect(result.error_code).toBe("GIT_OPERATION_IN_PROGRESS");
    expect(result.commit_sha).toBeNull();
    expect(await readFile(indexLock, "utf8")).toBe("foreign owner");
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
  });

  it.each(["boundary", "stage", "commit"])(
    "waits for a transient index lock at %s without deleting it",
    async (where) => {
      const f = await setup();
      await writeFile(join(f.repo, "contention.txt"), "frozen\n");
      await writeFile(join(f.repo, "b.txt"), "foreign edit\n");
      const indexLock = join(f.repo, ".git", "index.lock");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removedByOwner = false;
      let lockFailures = 0;
      const occupy = async () => {
        await writeFile(indexLock, "foreign owner", { flag: "wx" });
        timer = setTimeout(() => {
          void unlink(indexLock).then(() => {
            removedByOwner = true;
          });
        }, 150);
      };
      if (where === "boundary") await occupy();
      else {
        const original = f.coordinator.repository.git.run.bind(
          f.coordinator.repository.git,
        );
        let first = true;
        vi.spyOn(f.coordinator.repository.git, "run").mockImplementation(
          async (args, options) => {
            if (first && args.includes(where === "stage" ? "add" : "commit")) {
              first = false;
              await occupy();
            }
            const result = await original(args, options);
            if (result.indexLocked) lockFailures++;
            return result;
          },
        );
      }
      try {
        const result = await f.coordinator.commitAndPush({
          ...request("contention"),
          files: [
            {
              path: "contention.txt",
              operation: "add",
              sha256: createHash("sha256").update("frozen\n").digest("hex"),
              mode: "100644",
            },
          ],
        });
        expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
        expect(removedByOwner).toBe(true);
        if (where !== "boundary") expect(lockFailures).toBeGreaterThan(0);
        expect(
          await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`),
        ).toBe("1");
        expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe(
          "foreign edit\n",
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  );

  it("admits selected paths in a tree exceeding the output limit and still rejects gitlink descendants", async () => {
    const f = await fixture();
    resources.push(f);
    const runner = new GitRunner(f.repo);
    const blob = await git(f.repo, "rev-parse", "HEAD:a.txt");
    const entries = [
      `100644 blob ${blob}\ta.txt`,
      `100644 blob ${blob}\tb.txt`,
      `160000 commit ${f.base}\tlibrary`,
    ];
    for (let i = 0; i < 65000; i++)
      entries.push(
        `100644 blob ${blob}\tunrelated-${String(i).padStart(6, "0")}-${"x".repeat(200)}`,
      );
    const tree = await runner.text(["mktree"], {
      input: Buffer.from(entries.join("\n") + "\n"),
    });
    await git(f.repo, "read-tree", tree);
    await git(f.repo, "commit", "-qm", "Seed large unrelated corpus");
    await git(f.repo, "push", "origin", "main");
    const wholeTree = await runner.run(["ls-tree", "-r", "-z", "HEAD"]);
    expect(wholeTree.timedOut).toBe(true); // Reproduce the former admission failure.
    const coordinator = await Coordinator.open(f.config);
    resources.push(coordinator);
    await mkdir(join(f.repo, "library"));
    await writeFile(join(f.repo, "library", "nested.txt"), "submodule file\n");
    await expect(
      coordinator.commitAndPush(request("gitlink-child", "library/nested.txt")),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    await rm(join(f.repo, "library"), { recursive: true });
    await writeFile(join(f.repo, "selected.txt"), "selected\n");
    expect(
      await coordinator.repository.describe(["a.txt", "selected.txt"]),
    ).toEqual([
      { path: "a.txt", operation: "modify" },
      { path: "selected.txt", operation: "add" },
    ]);
    const result = await coordinator.commitAndPush(
      request("large-tree", "selected.txt"),
    );
    expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      result.commit_sha,
    );
  });

  it.each([false, true])(
    "checks admitted snapshot hashes before commit (stage race: %s)",
    async (stageRace) => {
      const f = await setup();
      await writeFile(join(f.repo, "sealed.txt"), "sealed\n");
      const sha256 = createHash("sha256").update("sealed\n").digest("hex");
      if (stageRace) {
        const original = f.coordinator.repository.stage.bind(
          f.coordinator.repository,
        );
        vi.spyOn(f.coordinator.repository, "stage").mockImplementation(
          async (files) => {
            await writeFile(join(f.repo, "sealed.txt"), "change\n");
            return original(files);
          },
        );
      } else
        await writeFile(
          join(f.repo, "sealed.txt"),
          "changed before validation\n",
        );
      const submitted = f.coordinator.commitAndPush({
        ...request("sealed"),
        files: [
          { path: "sealed.txt", operation: "add", sha256, mode: "100644" },
        ],
      });
      if (stageRace) {
        const result = await submitted;
        expect(result.status).toBe("PRECOMMIT_FAILED");
        expect(result.error_code).toBe("SNAPSHOT_CHANGED");
      } else {
        await expect(submitted).rejects.toMatchObject({
          code: "SNAPSHOT_CHANGED",
        });
        expect(f.coordinator.store.get("sealed")).toBeUndefined();
      }
      expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
      expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
      expect(await git(f.repo, "diff", "--cached", "--name-only")).toBe("");
      expect(await readFile(join(f.repo, "sealed.txt"), "utf8")).toContain(
        "change",
      );
    },
  );

  it.each(["error", "transition"])(
    "isolates request ID %s from internal event names",
    async (id) => {
      const f = await setup();
      await writeFile(join(f.repo, `${id}.txt`), id);
      expect((await f.coordinator.commitAndPush(request(id))).status).toBe(
        "SUCCEEDED",
      );
    },
  );
  it("serializes 20 agents in durable FIFO order and preserves unrelated edits", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "b.txt"), "other agent still editing\n");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(join(f.repo, `agent-${index}.txt`), `agent ${index}\n`),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        f.coordinator.commitAndPush(request(`agent-${index}`)),
      ),
    );
    expect(
      results.every(
        (result) => result.status === "SUCCEEDED" && result.pushed === true,
      ),
    ).toBe(true);
    const history = (
      await git(f.remote, "rev-list", "--reverse", `${f.base}..refs/heads/main`)
    ).split("\n");
    const accepted = f.coordinator.store.jobs();
    expect(history).toHaveLength(20);
    for (const [index, sha] of history.entries()) {
      expect(sha).toBe(accepted[index]!.commit_sha);
      const id = accepted[index]!.request_id;
      expect(await git(f.remote, "show", "-s", "--format=%B", sha)).toContain(
        `Git-Tx-Id: ${id}`,
      );
      expect(
        await git(
          f.remote,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          sha,
        ),
      ).toBe(`${id}.txt`);
    }
    expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe(
      "other agent still editing\n",
    );
    expect(await git(f.repo, "diff", "--cached", "--name-only")).toBe("");
  }, 60000);

  it("deduplicates simultaneous/restarted retries with changed wait timeout", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "once.txt"), "once");
    const results = await Promise.all([
      f.coordinator.commitAndPush(request("once")),
      f.coordinator.commitAndPush({
        ...request("once"),
        wait_timeout_seconds: 0,
      }),
    ]);
    const final = await f.coordinator.wait("once");
    expect(final.status).toBe("SUCCEEDED");
    expect(results[0]!.commit_sha).toBe(final.commit_sha);
    expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe(
      "1",
    );
    await expect(
      f.coordinator.commitAndPush({ ...request("once"), message: "different" }),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    await f.coordinator.close();
    resources.pop();
    const restarted = await f.open();
    resources.push(restarted);
    expect((await restarted.commitAndPush(request("once"))).commit_sha).toBe(
      final.commit_sha,
    );
  });

  it("supports modification, deletion, executable files, literal names, and no-op", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "a.txt"), "changed");
    await unlink(join(f.repo, "b.txt"));
    const path = "-dash\n:name.txt";
    await writeFile(join(f.repo, path), "literal");
    await chmod(join(f.repo, path), 0o755);
    const result = await f.coordinator.commitAndPush({
      request_id: "mixed",
      message: "Mixed",
      files: [
        { path: "a.txt", operation: "modify" },
        { path: "b.txt", operation: "delete" },
        { path, operation: "add" },
      ],
    });
    expect(result.status).toBe("SUCCEEDED");
    const noChange = await f.coordinator.commitAndPush({
      request_id: "noop",
      message: "No op",
      files: [{ path: "a.txt", operation: "modify" }],
    });
    expect(noChange.status).toBe("NO_CHANGES");
  });

  it("rejects symlinks, directory paths, wrong operations, and unallowlisted authors", async () => {
    const f = await setup();
    await symlink("a.txt", join(f.repo, "link"));
    await mkdir(join(f.repo, "directory"));
    for (const path of ["link", "directory"])
      await expect(
        f.coordinator.commitAndPush(request(path, path)),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    await expect(
      f.coordinator.commitAndPush(request("tracked", "a.txt")),
    ).rejects.toMatchObject({ code: "OPERATION_MISMATCH" });
    await expect(
      f.coordinator.commitAndPush({
        ...request("bad-author"),
        author: { name: "A", email: "a@example.com" },
      }),
    ).rejects.toMatchObject({ code: "AUTHOR_NOT_ALLOWED" });
    expect(f.coordinator.store.jobs()).toHaveLength(0);
  });

  it("cleans only its staged paths after a definitive precommit failure", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "new.txt"), "new");
    await writeFile(join(f.repo, "b.txt"), "other");
    vi.spyOn(f.coordinator.repository, "commit").mockRejectedValueOnce(
      new Error("injected failure"),
    );
    const result = await f.coordinator.commitAndPush(
      request("fail", "new.txt"),
    );
    expect(result.status).toBe("PRECOMMIT_FAILED");
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
    expect(await git(f.repo, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(f.repo, "new.txt"), "utf8")).toBe("new");
    expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe("other");
  });

  it("expires and cancels queued jobs without side effects; wait expiry leaves work running", async () => {
    const f = await setup({ slotMs: 1, minQueueMs: 150, maxQueueMs: 150 });
    for (const id of ["slow", "expire", "cancel"])
      await writeFile(join(f.repo, `${id}.txt`), id);
    const commit = f.coordinator.repository.commit.bind(
      f.coordinator.repository,
    );
    vi.spyOn(f.coordinator.repository, "commit").mockImplementationOnce(
      async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await commit(input);
      },
    );
    expect(
      (
        await f.coordinator.commitAndPush({
          ...request("slow"),
          wait_timeout_seconds: 0,
        })
      ).status,
    ).toBe("IN_PROGRESS");
    const expired = f.coordinator.commitAndPush(request("expire"));
    await f.coordinator.commitAndPush({
      ...request("cancel"),
      wait_timeout_seconds: 0,
    });
    expect(f.coordinator.cancel("cancel").status).toBe("CANCELLED_QUEUED");
    expect((await expired).status).toBe("QUEUE_EXPIRED");
    expect((await f.coordinator.wait("slow")).status).toBe("SUCCEEDED");
    expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe(
      "1",
    );
  });

  it("rejects excess queued work and makes queue observations non-reserving", async () => {
    const f = await setup({ maxPending: 1 });
    for (const id of ["first", "second", "third"])
      await writeFile(join(f.repo, `${id}.txt`), id);
    const commit = f.coordinator.repository.commit.bind(
      f.coordinator.repository,
    );
    vi.spyOn(f.coordinator.repository, "commit").mockImplementationOnce(
      async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await commit(input);
      },
    );
    expect(f.coordinator.queue().ahead_if_submitted).toBe(0);
    await f.coordinator.commitAndPush({
      ...request("first"),
      wait_timeout_seconds: 0,
    });
    await f.coordinator.commitAndPush({
      ...request("second"),
      wait_timeout_seconds: 0,
    });
    await expect(
      f.coordinator.commitAndPush(request("third")),
    ).rejects.toMatchObject({ code: "QUEUE_FULL" });
    expect(f.coordinator.queue().ahead_if_submitted).toBe(2);
    await f.coordinator.wait("second");
  });

  it("preserves a rejected local commit and blocks the next branch transaction", async () => {
    const f = await setup();
    const hook = join(f.remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const id of ["rejected", "later"])
      await writeFile(join(f.repo, `${id}.txt`), id);
    await f.coordinator.commitAndPush({
      ...request("rejected"),
      wait_timeout_seconds: 0,
    });
    await f.coordinator.commitAndPush({
      ...request("later"),
      wait_timeout_seconds: 0,
    });
    const result = await f.coordinator.wait("rejected");
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.commit_sha).toBe(await git(f.repo, "rev-parse", "HEAD"));
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
    expect(f.coordinator.status("later").durable_state).toBe("QUEUED");
    expect(f.coordinator.health).toBe("PAUSED");
    await unlink(hook);
    await f.coordinator.close();
    resources.pop();
    const restarted = await f.open();
    resources.push(restarted);
    expect((await restarted.wait("rejected")).status).toBe("SUCCEEDED");
    expect((await restarted.wait("later")).status).toBe("SUCCEEDED");
    expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe(
      "2",
    );
  });

  it("confirms a push whose acknowledgement is lost without committing twice", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "ack.txt"), "ack");
    const push = f.coordinator.repository.push.bind(f.coordinator.repository);
    vi.spyOn(f.coordinator.repository, "push").mockImplementationOnce(
      async (sha) => {
        await push(sha);
        throw new Error("ack lost");
      },
    );
    expect((await f.coordinator.commitAndPush(request("ack"))).status).toBe(
      "SUCCEEDED",
    );
    expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe(
      "1",
    );
  });

  it("detects external staging and local HEAD mutation without overwriting files", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "a.txt"), "external staged");
    await git(f.repo, "add", "a.txt");
    await writeFile(join(f.repo, "own.txt"), "own");
    expect(
      (await f.coordinator.commitAndPush(request("own"))).repository_state,
    ).toBe("PAUSED");
    expect(await git(f.repo, "diff", "--cached", "--name-only")).toBe("a.txt");
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
  });

  it("disables repository hooks, including pre-commit and post-commit", async () => {
    const f = await setup();
    for (const name of ["pre-commit", "post-commit", "pre-push"])
      await writeFile(
        join(f.repo, ".git", "hooks", name),
        "#!/bin/sh\necho damaged > b.txt\nexit 1\n",
        { mode: 0o755 },
      );
    await writeFile(join(f.repo, "hookless.txt"), "safe");
    expect(
      (await f.coordinator.commitAndPush(request("hookless"))).status,
    ).toBe("SUCCEEDED");
    expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe("b\n");
  });

  it("rejects a second singleton even with a different database location", async () => {
    const f = await setup();
    await expect(
      Coordinator.open({ ...f.config, stateDir: join(f.root, "other-state") }),
    ).rejects.toMatchObject({ code: "ALREADY_RUNNING" });
  });

  it("records publication and pauses if an external writer advances immediately after push", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "published.txt"), "published");
    const push = f.coordinator.repository.push.bind(f.coordinator.repository);
    vi.spyOn(f.coordinator.repository, "push").mockImplementationOnce(
      async (sha) => {
        await push(sha);
        const external = join(f.root, "external");
        await git(f.root, "clone", "--branch", "main", f.remote, external);
        await writeFile(join(external, "external.txt"), "external");
        await git(external, "add", "external.txt");
        await git(external, "commit", "-m", "External advance");
        await git(external, "push", "origin", "main");
      },
    );
    const result = await f.coordinator.commitAndPush(request("published"));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.repository_state).toBe("PAUSED");
    await f.coordinator.close();
    resources.pop();
    await git(f.repo, "fetch", "origin");
    await git(f.repo, "merge", "--ff-only", "origin/main");
    const restarted = await Coordinator.open({
      ...f.config,
      acceptAlignedHead: true,
    });
    resources.push(restarted);
    expect(restarted.health).toBe("READY");
    expect(restarted.status("published").commit_sha).toBe(result.commit_sha);
  });

  it("kills a timed-out push and preserves its unresolved commit", async () => {
    const f = await setup({ pushTimeoutMs: 50 });
    await writeFile(
      join(f.remote, "hooks", "pre-receive"),
      "#!/bin/sh\nsleep 2\n",
      { mode: 0o755 },
    );
    await writeFile(join(f.repo, "timeout.txt"), "timeout");
    const result = await f.coordinator.commitAndPush(request("timeout"));
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.commit_sha).toBe(await git(f.repo, "rev-parse", "HEAD"));
    expect(f.coordinator.health).toBe("PAUSED");
    expect(
      (result.stage_timings as Array<{ stage: string }>).some(
        (stage) => stage.stage === "push",
      ),
    ).toBe(true);
  });

  it("refuses to push a commit containing an unexpected staged file", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "owned.txt"), "owned");
    await writeFile(join(f.repo, "b.txt"), "external staged violation");
    const run = f.coordinator.repository.git.run.bind(
      f.coordinator.repository.git,
    );
    vi.spyOn(f.coordinator.repository.git, "run").mockImplementation(
      async (args, options) => {
        if (args.includes("commit")) await git(f.repo, "add", "b.txt");
        return run(args, options);
      },
    );
    const result = await f.coordinator.commitAndPush(request("owned"));
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.error_code).toBe("UNEXPECTED_PATHS");
    expect(result.commit_sha).not.toBeNull();
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
  });

  it("refuses foreign staging before commit without creating history or clearing it", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "owned.txt"), "owned");
    await writeFile(join(f.repo, "b.txt"), "foreign staged bytes");
    const commit = f.coordinator.repository.commit.bind(
      f.coordinator.repository,
    );
    vi.spyOn(f.coordinator.repository, "commit").mockImplementationOnce(
      async (input) => {
        await git(f.repo, "add", "b.txt");
        await commit(input);
      },
    );
    const result = await f.coordinator.commitAndPush(request("owned"));
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.error_code).toBe("UNEXPECTED_PATHS");
    expect(result.commit_sha).toBeNull();
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
    expect(await git(f.repo, "diff", "--cached", "--name-only")).toContain(
      "b.txt",
    );
    expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe(
      "foreign staged bytes",
    );
  });
});
