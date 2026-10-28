import { createHash } from "node:crypto";
import { readFile, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import {
  requestSchema,
  digestRequest,
  sanitizedError,
  TxdError,
} from "../src/model.js";
import { GitRunner, MAX_SNAPSHOT_BYTES } from "../src/runner.js";
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
const setup = async () => {
  const f = await fixture();
  resources.push(f);
  const coordinator = await f.open();
  resources.push(coordinator);
  return { ...f, coordinator };
};
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("streamed admitted snapshots", () => {
  it.each(["text", "binary"])(
    "commits and pushes 24 MiB %s without buffered blob capture",
    async (kind) => {
      const f = await setup();
      const bytes = Buffer.alloc(
        24 * 1024 * 1024,
        kind === "text" ? 0x61 : 0xff,
      );
      const path = `${kind}.dat`;
      await writeFile(join(f.repo, path), bytes);
      const input = {
        ...request(`large-${kind}`, path),
        files: [
          {
            path,
            operation: "add" as const,
            sha256: sha256(bytes),
            mode: "100644" as const,
          },
        ],
      };
      const result = await f.coordinator.commitAndPush(input);
      expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
      expect(result.pushed).toBe(true);
      expect(await git(f.remote, "rev-parse", "main")).toBe(result.commit_sha);
      const runner = new GitRunner(f.repo);
      const blob = await runner.hashBlob(
        ["show", `HEAD:${path}`],
        bytes.length,
      );
      expect(blob.stdout.length).toBe(0);
      expect(blob.stdoutBytes).toBe(bytes.length);
      expect(blob.stdoutSha256).toBe(input.files[0]!.sha256);
      expect(blob.custody.child_close_observed).toBe(true);
      expect(runner.children.size).toBe(0);
      const saved = JSON.parse(
        f.coordinator.store.get(input.request_id)!.payload_json,
      );
      expect(saved.snapshot_sizes).toEqual({ [path]: bytes.length });
      expect(digestRequest(saved, "repo")).toBe(digestRequest(input, "repo"));
      expect(requestSchema.safeParse(saved).success).toBe(false);
      expect((await f.coordinator.commitAndPush(input)).commit_sha).toBe(
        result.commit_sha,
      );
    },
    60_000,
  );
});

describe("snapshot admission and recovery", () => {
  it("refuses a caller-supplied internal size map", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "injected.txt"), "content");
    await expect(
      f.coordinator.commitAndPush({
        ...request("injected"),
        snapshot_sizes: { "injected.txt": 7 },
      }),
    ).rejects.toThrow();
    expect(f.coordinator.store.get("injected")).toBeUndefined();
  });

  it("refuses a sparse file above the one GiB bound before staging", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "huge.txt"), "");
    await truncate(join(f.repo, "huge.txt"), MAX_SNAPSHOT_BYTES + 1);
    await expect(
      f.coordinator.commitAndPush(request("huge")),
    ).rejects.toMatchObject({ code: "SNAPSHOT_SIZE_LIMIT" });
    expect(await f.coordinator.repository.stagedPaths()).toEqual([]);
  });

  it("recovers a legacy queued payload without internal sizes", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "legacy.txt"), "retained legacy input");
    const input = {
      ...request("legacy"),
      files: [
        {
          path: "legacy.txt",
          operation: "add" as const,
          sha256: sha256(Buffer.from("retained legacy input")),
        },
      ],
    };
    const identity = `${f.coordinator.repository.identity}:main:origin`;
    f.coordinator.store.insert(
      input,
      digestRequest(input, identity),
      Date.now() + 60_000,
    );
    await f.coordinator.close();
    const restarted = await f.open();
    resources.push(restarted);
    const result = await restarted.wait("legacy", 30);
    expect(result.status, JSON.stringify(result)).toBe("SUCCEEDED");
    expect(await git(f.remote, "rev-parse", "main")).toBe(result.commit_sha);
  }, 30_000);

  it("rejects admitted size drift after restart even without a supplied hash", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "resized.txt"), "before");
    vi.spyOn(
      f.coordinator as unknown as { kick(): void },
      "kick",
    ).mockImplementation(() => {});
    const input = { ...request("resized"), wait_timeout_seconds: 0 };
    expect((await f.coordinator.commitAndPush(input)).status).toBe(
      "IN_PROGRESS",
    );
    expect(
      JSON.parse(f.coordinator.store.get("resized")!.payload_json)
        .snapshot_sizes,
    ).toEqual({ "resized.txt": 6 });
    await f.coordinator.close();
    await writeFile(join(f.repo, "resized.txt"), "changed length");
    const restarted = await f.open();
    resources.push(restarted);
    const result = await restarted.wait("resized", 30);
    expect(result.status).toBe("PRECOMMIT_FAILED");
    expect(result.error_code).toBe("SNAPSHOT_CHANGED");
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
  }, 30_000);

  it.each(["hash", "size", "missing-size"])(
    "rejects an incorrect staged %s",
    async (variant) => {
      const f = await setup();
      const bytes = Buffer.from("exact admitted bytes");
      await writeFile(join(f.repo, "checked.txt"), bytes);
      const file = {
        path: "checked.txt",
        operation: "add" as const,
        sha256: variant === "hash" ? "0".repeat(64) : sha256(bytes),
      };
      await f.coordinator.repository.stage([file]);
      const snapshot_sizes =
        variant === "missing-size"
          ? undefined
          : { "checked.txt": bytes.length + Number(variant === "size") };
      await expect(
        f.coordinator.repository.commit({
          ...request("checked"),
          files: [file],
          ...(snapshot_sizes ? { snapshot_sizes } : {}),
        }),
      ).rejects.toMatchObject({
        code:
          variant === "missing-size"
            ? "SNAPSHOT_SIZE_MISSING"
            : "SNAPSHOT_CHANGED",
      });
      expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
    },
  );
});

describe("bounded Git output and custody", () => {
  it("keeps the ordinary captured-output limit", async () => {
    const f = await setup();
    await writeFile(
      join(f.repo, "buffered.dat"),
      Buffer.alloc(24 * 1024 * 1024, 1),
    );
    await f.coordinator.repository.stage([
      { path: "buffered.dat", operation: "add" },
    ]);
    const runner = new GitRunner(f.repo);
    const result = await runner.run(["show", ":buffered.dat"]);
    expect(result.outputExceeded).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.custody.child_close_observed).toBe(true);
    expect(runner.children.size).toBe(0);
  });

  it("bounds hashing and supports empty blobs and pre-launch cancellation", async () => {
    const f = await setup();
    const runner = new GitRunner(f.repo);
    for (const size of [-1, 1.5, NaN, MAX_SNAPSHOT_BYTES + 1])
      await expect(
        runner.hashBlob(["show", "HEAD:a.txt"], size),
      ).rejects.toMatchObject({ code: "SNAPSHOT_SIZE_LIMIT" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run(["status"], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "GIT_ABORTED" });
    await writeFile(join(f.repo, "empty.txt"), "");
    await f.coordinator.repository.stage([
      { path: "empty.txt", operation: "add" },
    ]);
    const empty = await runner.hashBlob(["show", ":empty.txt"], 0);
    expect(empty.stdoutBytes).toBe(0);
    expect(empty.stdoutSha256).toBe(sha256(Buffer.alloc(0)));
    expect(empty.stdout.length).toBe(0);
    expect(runner.children.size).toBe(0);
  });

  it("retains failed-signal custody after actual close and blocks further commands", async () => {
    const f = await setup();
    await writeFile(join(f.repo, "signal.dat"), Buffer.alloc(1024 * 1024, 1));
    await f.coordinator.repository.stage([
      { path: "signal.dat", operation: "add" },
    ]);
    const runner = new GitRunner(f.repo);
    const denied = Object.assign(new Error("private kill details"), {
      code: "EPERM",
    });
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw denied;
    });
    await expect(
      runner.hashBlob(["show", ":signal.dat"], 0),
    ).rejects.toMatchObject({
      code: "GIT_TERMINATION_FAILED",
      cause: denied,
      custody: { child_close_observed: true },
    });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(runner.children.size).toBe(0);
    signal.mockRestore();
    await expect(runner.run(["rev-parse", "HEAD"])).rejects.toMatchObject({
      code: "GIT_CUSTODY_UNCONFIRMED",
    });
  });

  it.each(["commit", "push"] as const)(
    "pauses on uncertain %s custody and journals sanitized details",
    async (stage) => {
      const f = await setup();
      await writeFile(join(f.repo, "custody.txt"), "content");
      const failure = Object.assign(
        new TxdError(
          "GIT_TERMINATION_FAILED",
          "private command or credentials",
        ),
        {
          cause: Object.assign(new Error("private cause"), { code: "EPERM" }),
          custody: {
            pid: 123,
            child_close_observed: false,
            lock_inherited: true,
            command: "secret",
          },
        },
      );
      vi.spyOn(f.coordinator.repository, stage).mockRejectedValueOnce(failure);
      const cleanup = vi.spyOn(f.coordinator.repository, "cleanRequestIndex");
      const result = await f.coordinator.commitAndPush(request("custody"));
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(result.error_code).toBe("GIT_TERMINATION_FAILED");
      expect(cleanup).not.toHaveBeenCalled();
      const kind =
        stage === "commit" ? "PRECOMMIT_DIAGNOSTIC" : "CUSTODY_DIAGNOSTIC";
      const row = f.coordinator.store.db
        .prepare(
          "SELECT details_json FROM transaction_events WHERE request_id=? AND event_type=?",
        )
        .get("custody", kind) as { details_json: string };
      const diagnostic = JSON.parse(row.details_json);
      expect(diagnostic.code).toBe("GIT_TERMINATION_FAILED");
      expect(diagnostic.cause_code).toBe("EPERM");
      expect(diagnostic.custody).toEqual({
        pid: 123,
        child_close_observed: false,
        lock_inherited: true,
      });
      expect(row.details_json).not.toMatch(/private|secret/);
    },
  );

  it("does not invoke diagnostic getters or retain untrusted strings", () => {
    let invoked = false;
    const error = Object.defineProperties(
      new Error("secret https://credentials"),
      {
        code: {
          get() {
            invoked = true;
            return "EPERM";
          },
        },
        cause: { value: { code: "secret errno" } },
      },
    );
    expect(sanitizedError(error, "secret stage")).toEqual({
      kind: "Error",
      code: null,
      cause_code: null,
      stage: "unknown",
    });
    expect(invoked).toBe(false);
  });
});
