import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixture, git, request } from "./helpers.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

it.each(["staged", "staged-expired", "committed", "pushed"])(
  "recovers an actual SIGKILL after %s without a duplicate commit",
  async (stage) => {
    const f = await fixture();
    cleanup.push(f.remove);
    await writeFile(join(f.repo, "crash.txt"), "recover me");
    await writeFile(join(f.repo, "b.txt"), "other agent");
    const configFile = join(f.root, "config.json");
    const config =
      stage === "staged-expired"
        ? { ...f.config, minQueueMs: 100, slotMs: 100, maxQueueMs: 100 }
        : f.config;
    await writeFile(configFile, JSON.stringify(config));
    const child = spawn(
      process.execPath,
      [
        resolve("tests/crash-child.mjs"),
        configFile,
        stage === "staged-expired" ? "staged" : stage,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("No crash checkpoint")),
        10000,
      );
      child.stdout.on("data", (data) => {
        if (data.toString().includes("CHECKPOINT")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Crash helper exited before checkpoint"));
      });
    });
    child.kill("SIGSTOP");
    await expect(f.open()).rejects.toMatchObject({ code: "ALREADY_RUNNING" });
    child.kill("SIGKILL");
    await once(child, "exit");
    if (stage === "staged-expired")
      await new Promise((resolve) => setTimeout(resolve, 250));
    const { Coordinator } = await import("../src/coordinator.js");
    const restarted = await Coordinator.open(config);
    cleanup.push(() => restarted.close());
    const result = await restarted.commitAndPush(request("crash"));
    expect(result.status).toBe("SUCCEEDED");
    expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe(
      "1",
    );
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      result.commit_sha,
    );
    expect(await git(f.repo, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe("other agent");
  },
  30000,
);

it("retains the kernel lock in a Git child after the daemon is killed during push", async () => {
  const f = await fixture();
  cleanup.push(f.remove);
  await writeFile(join(f.repo, "crash.txt"), "recover me");
  const marker = join(f.root, "push-started");
  await writeFile(
    join(f.remote, "hooks", "pre-receive"),
    `#!/bin/sh\ntouch '${marker}'\nsleep 2\n`,
    { mode: 0o755 },
  );
  const configFile = join(f.root, "config.json");
  await writeFile(configFile, JSON.stringify(f.config));
  const child = spawn(
    process.execPath,
    [resolve("tests/crash-child.mjs"), configFile, "pushed"],
    { stdio: "ignore" },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await readFile(marker);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("Push never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  child.kill("SIGKILL");
  await once(child, "exit");
  await expect(f.open()).rejects.toMatchObject({ code: "ALREADY_RUNNING" });
  let restarted;
  while (!restarted) {
    try {
      restarted = await f.open();
    } catch (error) {
      if (
        (error as { code: string }).code !== "ALREADY_RUNNING" ||
        Date.now() > deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  cleanup.push(() => restarted!.close());
  expect((await restarted.commitAndPush(request("crash"))).status).toBe(
    "SUCCEEDED",
  );
  expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe("1");
}, 30000);

it("pauses when an external writer advances the remote, preserving dirty work", async () => {
  const f = await fixture();
  cleanup.push(f.remove);
  const coordinator = await f.open();
  cleanup.push(() => coordinator.close());
  const external = join(f.root, "external");
  await git(f.root, "clone", "--branch", "main", f.remote, external);
  await writeFile(join(external, "external.txt"), "external");
  await git(external, "add", "external.txt");
  await git(external, "commit", "-m", "External writer");
  await git(external, "push", "origin", "main");
  await writeFile(join(f.repo, "own.txt"), "own");
  await writeFile(join(f.repo, "b.txt"), "dirty");
  const result = await coordinator.commitAndPush(request("own"));
  expect(result.repository_state).toBe("PAUSED");
  expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
  expect(await readFile(join(f.repo, "b.txt"), "utf8")).toBe("dirty");
});
