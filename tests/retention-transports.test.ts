import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  Client as McpClient,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "../src/api.js";
import { startDaemon } from "../src/http.js";
import { Store } from "../src/store.js";
import { fixture, git, request } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

it("preserves MCP/CLI retries, conflict rejection and recovery after automatic archival", async () => {
  const f = await fixture();
  cleanup.push(f.remove);
  let daemon = await startDaemon(f.config);
  cleanup.push(() => daemon.close());
  const token = (await readFile(daemon.tokenFile, "utf8")).trim();
  const client = new Client(daemon.url, token);
  const mcp = new McpClient({ name: "retention-fixture", version: "1.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  cleanup.push(() => mcp.close());
  await writeFile(join(f.repo, "cold.txt"), "immutable payload\n");
  const input = request("cold");
  const initial = await mcp.callTool({
    name: "git_commit_and_push",
    arguments: input,
  });
  const result = initial.structuredContent as Record<string, unknown>;
  expect(result.status).toBe("SUCCEEDED");
  expect(result.pushed).toBe(true);
  const sha = String(result.commit_sha);
  expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(sha);
  await client.queue();
  daemon.coordinator.store.db
    .prepare("UPDATE transactions SET finished_at_ms=? WHERE request_id=?")
    .run(Date.now() - 40 * 86400000, "cold");
  const before = daemon.coordinator.status("cold");
  const counts = daemon.coordinator.queue().event_counts;
  daemon.coordinator.archiveHistory(Date.now() + 3600001);
  expect(daemon.coordinator.store.get("cold")!.payload_json).toBe("{}");
  expect(daemon.coordinator.status("cold")).toEqual(before);
  expect(daemon.coordinator.queue().event_counts).toEqual(counts);
  const cli = await exec(process.execPath, [
    resolve("dist/cli.js"),
    "--url",
    daemon.url,
    "--token-file",
    daemon.tokenFile,
    "--json",
    "commit",
    "--request-id",
    "cold",
    "--file",
    "cold.txt",
    "--message",
    "Add cold",
  ]);
  expect(JSON.parse(cli.stdout)).toEqual(before);
  const retry = await mcp.callTool({
    name: "git_commit_and_push",
    arguments: input,
  });
  expect(retry.structuredContent).toEqual(before);
  const conflict = await mcp.callTool({
    name: "git_commit_and_push",
    arguments: { ...input, message: "Different logical request" },
  });
  expect(conflict.isError).toBe(true);
  expect(JSON.stringify(conflict)).toContain("REQUEST_ID_CONFLICT");
  expect(await git(f.repo, "rev-list", "--count", "HEAD")).toBe("2");
  expect(await git(f.repo, "diff", "--cached", "--name-only")).toBe("");
  expect(await readFile(join(f.repo, "cold.txt"), "utf8")).toBe(
    "immutable payload\n",
  );
  // Losing audit storage must neither free the ID nor block recovery of a terminal result.
  const archive = daemon.coordinator.store.history.record("cold")!;
  await rm(join(f.stateDir, "archives", archive.filename));
  expect((await client.commitAndPush(input)).commit_sha).toBe(sha);
  await expect(
    client.call("describe", { paths: ["cold.txt"], request_id: "cold" }),
  ).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
  await mcp.close();
  cleanup.pop();
  await daemon.close();
  daemon = await startDaemon(f.config);
  const restarted = new Client(daemon.url, token);
  expect((await restarted.queue()).repository_state).toBe("READY");
  expect((await restarted.commitAndPush(input)).commit_sha).toBe(sha);
  await expect(
    restarted.commitAndPush({ ...input, message: "conflict" }),
  ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
  await writeFile(join(f.repo, "next.txt"), "next\n");
  const next = await restarted.commitAndPush(request("next"));
  expect(next.status).toBe("SUCCEEDED");
  expect(next.enqueue_seq).toBe(2);
  expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
    next.commit_sha,
  );
  const logs = await readFile(join(f.stateDir, "logs", "daemon.log"), "utf8");
  expect(logs).toContain('"event":"TRANSACTION_STATE"');
  expect(logs).toContain('"event":"LEDGER_ARCHIVAL"');
}, 90000);

it("keeps pending payloads intact and archives only while idle", async () => {
  const f = await fixture();
  cleanup.push(f.remove);
  await mkdir(f.stateDir, { mode: 0o700 });
  const seeded = new Store(join(f.stateDir, "ledger.sqlite"));
  seeded.insert(request("old-terminal"), "old-terminal", Date.now() - 86400000);
  seeded.update("old-terminal", "CANCELLED_QUEUED", {
    finished_at_ms: Date.now() - 40 * 86400000,
  });
  seeded.close();
  const daemon = await startDaemon(f.config);
  cleanup.push(daemon.close);
  const store = daemon.coordinator.store;
  store.insert(request("pending"), "pending", Date.now() + 60000);
  const pending = store.get("pending");
  daemon.coordinator.archiveHistory(Date.now() + 10000000000);
  expect(store.get("pending")).toEqual(pending);
  expect(store.history.record("pending")).toBeUndefined();
  store.update("pending", "CANCELLED_QUEUED", { finished_at_ms: Date.now() });
  await vi.waitFor(
    () => expect(store.get("old-terminal")!.payload_json).toBe("{}"),
    { timeout: 5000 },
  );
  expect(store.get("pending")!.payload_json).not.toBe("{}");
  expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.base);
}, 30000);
