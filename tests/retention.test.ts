import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type Status } from "../src/model.js";
import { LOG_MAX_BYTES, RotatingLog } from "../src/rotating-log.js";
import { Store } from "../src/store.js";
import { request } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), "git-txd-retention-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const archiveName = (id: string) =>
  `${createHash("sha256").update(id).digest("hex")}.json.gz`;
const old = Date.now() - 40 * 86400000;
const seed = (
  store: Store,
  id = "cold",
  status: Status = "SUCCEEDED",
  finished = old,
) => {
  const job = store.insert(request(id), `digest-${id}`, Date.now() + 60000);
  store.event(id, "STAGE_TIMING", { stage: "commit", duration_ms: 10 });
  return store.update(id, status, {
    finished_at_ms: finished,
    commit_sha: status === "SUCCEEDED" ? "a".repeat(40) : null,
    expected_parent: "b".repeat(40),
  });
};
const setup = async () => {
  const directory = await temporary();
  const store = new Store(join(directory, "ledger.sqlite"));
  cleanup.push(() => store.close());
  return { directory, store };
};

describe("bounded diagnostic logs", () => {
  it("rotates at the production 10 MiB boundary into a private gzip", async () => {
    const directory = await temporary();
    const path = join(directory, "daemon.log");
    const log = new RotatingLog(path);
    cleanup.push(() => log.close());
    const record = "x".repeat(LOG_MAX_BYTES - 3);
    log.write(record);
    expect((await stat(path)).size).toBe(LOG_MAX_BYTES);
    log.write("next");
    expect(gunzipSync(await readFile(`${path}.1.gz`)).toString()).toBe(
      `${JSON.stringify(record)}\n`,
    );
    expect((await stat(path)).size).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect((await stat(`${path}.1.gz`)).mode & 0o777).toBe(0o600);
  });

  it("keeps exactly five archives in order, including oversized UTF-8 records", async () => {
    const directory = await temporary();
    const path = join(directory, "daemon.log");
    const log = new RotatingLog(path, 16);
    cleanup.push(() => log.close());
    const bytes = Buffer.from(`${JSON.stringify("中".repeat(48))}\n`);
    log.write("中".repeat(48));
    expect((await readdir(directory)).sort()).toEqual([
      "daemon.log",
      ...[1, 2, 3, 4, 5].map((n) => `daemon.log.${n}.gz`),
    ]);
    const pieces = await Promise.all(
      [5, 4, 3, 2, 1].map(async (n) =>
        gunzipSync(await readFile(`${path}.${n}.gz`)),
      ),
    );
    pieces.push(await readFile(path));
    expect(Buffer.concat(pieces)).toEqual(bytes.subarray(64));
    for (const n of [1, 2, 3, 4, 5])
      expect(gunzipSync(await readFile(`${path}.${n}.gz`)).length).toBe(16);
  });

  it("imports an oversized existing log with bounded segments on restart", async () => {
    const directory = await temporary();
    const path = join(directory, "daemon.log");
    await writeFile(path, Buffer.from("abcdefgh".repeat(20)), { mode: 0o600 });
    const log = new RotatingLog(path, 16);
    cleanup.push(() => log.close());
    expect((await stat(path)).size).toBe(0);
    expect((await readdir(directory)).length).toBe(6);
    for (const n of [1, 2, 3, 4, 5])
      expect(gunzipSync(await readFile(`${path}.${n}.gz`)).length).toBe(16);
  });

  it("leaves active bytes intact when archive publication fails", async () => {
    const directory = await temporary();
    const path = join(directory, "daemon.log");
    const log = new RotatingLog(path, 8);
    cleanup.push(() => log.close());
    log.write("12345");
    const before = await readFile(path);
    await mkdir(`${path}.1.gz.pending`);
    expect(() => log.write("next")).toThrow();
    expect(await readFile(path)).toEqual(before);
    await rm(`${path}.1.gz.pending`, { recursive: true });
    log.write("next");
    expect(await readFile(path, "utf8")).toBe('"next"\n');
  });

  it("refuses symlink and public log targets without changing them", async () => {
    const directory = await temporary();
    const victim = join(directory, "victim");
    await writeFile(victim, "preserve", { mode: 0o600 });
    await symlink(victim, join(directory, "daemon.log"));
    expect(() => new RotatingLog(join(directory, "daemon.log"))).toThrow();
    await chmod(victim, 0o644);
    expect(() => new RotatingLog(victim)).toThrow();
    expect(await readFile(victim, "utf8")).toBe("preserve");
  });
});

describe("durable terminal history archival", () => {
  it("retains identity/outcome, summaries, counters and full verifiable history", async () => {
    const { directory, store } = await setup();
    const job = seed(store);
    const events = store.db
      .prepare("SELECT * FROM transaction_events ORDER BY event_id")
      .all();
    const counts = store.eventCounts();
    const stages = store.stageTimings("cold");
    expect(store.archive(Date.now() - 30 * 86400000, 100)).toEqual({
      archived: 1,
      deferred: 0,
    });
    expect(store.get("cold")).toEqual({ ...job, payload_json: "{}" });
    expect(store.payload(store.get("cold")!)).toBe(job.payload_json);
    const data = JSON.parse(
      gunzipSync(
        await readFile(join(directory, "archives", archiveName("cold"))),
      ).toString(),
    );
    expect(data).toEqual({ version: 1, job, events });
    expect(store.eventCounts()).toEqual(counts);
    expect(store.stageTimings("cold")).toEqual(stages);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM transaction_events").get(),
    ).toEqual({ n: 0 });
    store.event("cold", "DUPLICATE_REQUEST");
    expect(store.eventCounts()).toEqual(counts);
    expect(() => store.update("cold", "QUEUED")).toThrow("immutable");
    expect(store.archive(Date.now(), 100).archived).toBe(0);
  });

  it.each([
    "SUCCEEDED",
    "NO_CHANGES",
    "PRECOMMIT_FAILED",
    "QUEUE_EXPIRED",
    "CANCELLED_QUEUED",
  ] as const)("archives definitive %s outcomes", async (status) => {
    const { store } = await setup();
    seed(store, "cold", status);
    expect(store.archive(Date.now(), 100).archived).toBe(1);
    expect(store.get("cold")!.status).toBe(status);
  });

  it.each([
    "QUEUED",
    "RUNNING_PRECOMMIT",
    "LOCAL_COMMITTED",
    "PUSHING",
    "RECONCILING",
    "PUSH_PENDING",
    "RECONCILIATION_REQUIRED",
  ] as const)(
    "preserves unresolved %s bytes and events even with an old timestamp",
    async (status) => {
      const { store } = await setup();
      const job = seed(store, "held", status);
      const events = store.db.prepare("SELECT * FROM transaction_events").all();
      expect(store.archive(Date.now(), 100).archived).toBe(0);
      expect(store.get("held")).toEqual(job);
      expect(
        store.db.prepare("SELECT * FROM transaction_events").all(),
      ).toEqual(events);
    },
  );

  it("respects age and batch limits and never reuses an archived queue sequence", async () => {
    const { store } = await setup();
    seed(store, "a");
    seed(store, "b");
    seed(store, "recent", "SUCCEEDED", Date.now());
    expect(store.archive(Date.now() - 86400000, 1).archived).toBe(1);
    expect(store.archive(Date.now() - 86400000, 1).archived).toBe(1);
    expect(store.get("recent")!.payload_json).not.toBe("{}");
    expect(
      store.insert(request("next"), "next", Date.now() + 1000).enqueue_seq,
    ).toBe(4);
  });

  it("retains originals on a failed archive write", async () => {
    const { directory, store } = await setup();
    const job = seed(store);
    await mkdir(join(directory, "archives"), { mode: 0o700 });
    await mkdir(join(directory, "archives", `${archiveName("cold")}.pending`));
    expect(() => store.archive(Date.now(), 100)).toThrow();
    expect(store.get("cold")).toEqual(job);
    expect(store.history.record("cold")).toBeUndefined();
  });

  it("rolls back compaction and safely reuses a durable orphan after SQL failure", async () => {
    const { directory, store } = await setup();
    const job = seed(store);
    store.db.exec(
      "CREATE TRIGGER fail_archive BEFORE INSERT ON transaction_archives BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    );
    expect(() => store.archive(Date.now(), 100)).toThrow();
    expect(store.get("cold")).toEqual(job);
    expect(
      (await stat(join(directory, "archives", archiveName("cold")))).size,
    ).toBeGreaterThan(0);
    store.db.exec("DROP TRIGGER fail_archive");
    expect(store.archive(Date.now(), 100).archived).toBe(1);
    expect(store.payload(store.get("cold")!)).toBe(job.payload_json);
  });

  it.each(["before-transaction", "inside-transaction"])(
    "recovers a real SIGKILL %s without losing originals",
    async (phase) => {
      const directory = await temporary();
      const path = join(directory, "ledger.sqlite");
      const store = new Store(path);
      const job = seed(store);
      store.close();
      const script = `import {Store} from ${JSON.stringify(new URL(`file://${resolve("dist/store.js")}`).href)};
      const s=new Store(process.argv[1]);
      if(process.argv[2]==='before-transaction') s.history.compact=()=>process.kill(process.pid,'SIGKILL');
      else {s.db.function('crash',()=>process.kill(process.pid,'SIGKILL'));s.db.exec("CREATE TEMP TRIGGER crash_archive AFTER INSERT ON transaction_archives BEGIN SELECT crash(); END;");}
      s.archive(Date.now(),100);`;
      await expect(
        exec(process.execPath, [
          "--input-type=module",
          "-e",
          script,
          path,
          phase,
        ]),
      ).rejects.toMatchObject({ signal: "SIGKILL" });
      const reopened = new Store(path);
      cleanup.push(() => reopened.close());
      expect(reopened.get("cold")).toEqual(job);
      expect(reopened.history.record("cold")).toBeUndefined();
      expect(reopened.archive(Date.now(), 100).archived).toBe(1);
      expect(reopened.payload(reopened.get("cold")!)).toBe(job.payload_json);
    },
  );

  it("fails closed for corrupt or missing archives while keeping outcome/digest available", async () => {
    const { directory, store } = await setup();
    const job = seed(store);
    store.archive(Date.now(), 100);
    const path = join(directory, "archives", archiveName("cold"));
    await writeFile(path, "corrupt");
    expect(() => store.payload(store.get("cold")!)).toThrow("archive");
    await rm(path);
    expect(() => store.payload(store.get("cold")!)).toThrow("archive");
    expect(store.get("cold")).toEqual({ ...job, payload_json: "{}" });
    expect(store.stageTimings("cold")).toEqual([
      { stage: "commit", duration_ms: 10 },
    ]);
  });

  it("defers unusually large histories without partial deletion", async () => {
    const { store } = await setup();
    const job = seed(store);
    store.event("cold", "LARGE", { text: "x".repeat(5 * 1024 * 1024) });
    expect(store.archive(Date.now(), 100)).toEqual({
      archived: 0,
      deferred: 1,
    });
    expect(store.get("cold")).toEqual(job);
    expect(store.history.record("cold")).toBeUndefined();
  });

  it("upgrades a legacy ledger additively without altering pending data", async () => {
    const directory = await temporary();
    const path = join(directory, "ledger.sqlite");
    const original = new Store(path);
    const job = seed(original, "held", "LOCAL_COMMITTED");
    original.db.exec(
      "DROP TABLE transaction_archives; DROP TABLE archived_event_counts; PRAGMA user_version=1;",
    );
    original.close();
    const reopened = new Store(path);
    cleanup.push(() => reopened.close());
    expect(reopened.get("held")).toEqual(job);
    expect(reopened.archive(Date.now(), 100).archived).toBe(0);
  });
});
