import { createHash } from "node:crypto";
import { join } from "node:path";
import { type DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { type Job, isTerminal, TxdError } from "./model.js";
import {
  privateDirectory,
  privateRead,
  publishArchive,
} from "./retention-files.js";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const TERMINAL = [
  "SUCCEEDED",
  "NO_CHANGES",
  "PRECOMMIT_FAILED",
  "QUEUE_EXPIRED",
  "CANCELLED_QUEUED",
];
interface EventRow {
  event_id: number;
  request_id: string;
  event_type: string;
  event_at_ms: number;
  details_json: string;
}
interface ArchiveRow {
  filename: string;
  sha256: string;
  stage_timings_json: string;
}
const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Durable compressed history with permanent outcome/digest rows in the live ledger. */
export class LedgerArchive {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stateDir: string,
  ) {}

  record(id: string): ArchiveRow | undefined {
    return this.db
      .prepare("SELECT * FROM transaction_archives WHERE request_id=?")
      .get(id) as unknown as ArchiveRow | undefined;
  }

  /** Historical payload access fails closed; retry identity never depends on this file. */
  payload(job: Job): string {
    const record = this.record(job.request_id);
    if (!record) return job.payload_json;
    try {
      if (!/^[a-f0-9]{64}\.json\.gz$/.test(record.filename))
        throw new Error("Archive name");
      const bytes = privateRead(
        join(this.stateDir, "archives", record.filename),
      );
      if (digest(bytes) !== record.sha256) throw new Error("Archive checksum");
      const data = JSON.parse(
        gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_BYTES }).toString(
          "utf8",
        ),
      ) as { version: number; job: Job };
      if (
        data.version !== 1 ||
        data.job.request_id !== job.request_id ||
        data.job.request_digest !== job.request_digest ||
        typeof data.job.payload_json !== "string"
      )
        throw new Error("Archive identity");
      return data.job.payload_json;
    } catch {
      throw new TxdError(
        "ARCHIVE_UNAVAILABLE",
        "Historical payload archive is missing or invalid; original request ID and outcome remain reserved.",
      );
    }
  }

  /** Copy, fsync, verify, then atomically compact only old definitive terminal jobs. */
  run(cutoff: number, limit: number): { archived: number; deferred: number } {
    const jobs = this.db
      .prepare(
        `SELECT t.* FROM transactions t WHERE status IN (${TERMINAL.map(() => "?").join(",")}) AND finished_at_ms IS NOT NULL AND finished_at_ms < ? AND NOT EXISTS (SELECT 1 FROM transaction_archives a WHERE a.request_id=t.request_id) ORDER BY finished_at_ms,enqueue_seq LIMIT ?`,
      )
      .all(...TERMINAL, cutoff, limit) as unknown as Job[];
    let archived = 0;
    let deferred = 0;
    for (const job of jobs) {
      const size = this.db
        .prepare(
          "SELECT count(*) AS count, coalesce(sum(length(CAST(details_json AS BLOB))),0) AS bytes FROM transaction_events WHERE request_id=?",
        )
        .get(job.request_id) as { count: number; bytes: number };
      if (
        size.count > 10000 ||
        size.bytes + Buffer.byteLength(job.payload_json) > MAX_ARCHIVE_BYTES / 4
      ) {
        deferred++;
        continue;
      }
      const events = this.db
        .prepare(
          "SELECT * FROM transaction_events WHERE request_id=? ORDER BY event_id",
        )
        .all(job.request_id) as unknown as EventRow[];
      const raw = Buffer.from(JSON.stringify({ version: 1, job, events }));
      if (raw.length > MAX_ARCHIVE_BYTES) {
        deferred++;
        continue;
      }
      const directory = privateDirectory(join(this.stateDir, "archives"));
      const filename = `${digest(Buffer.from(job.request_id))}.json.gz`;
      const path = join(directory, filename);
      const bytes = gzipSync(raw);
      publishArchive(path, bytes);
      if (digest(privateRead(path)) !== digest(bytes))
        throw new Error("Archive verification failed");
      this.compact(job, events, {
        filename,
        sha256: digest(bytes),
        stage_timings_json: JSON.stringify(
          events
            .filter((event) => event.event_type === "STAGE_TIMING")
            .map((event) => JSON.parse(event.details_json) as unknown),
        ),
      });
      archived++;
    }
    if (archived) {
      this.db.exec(
        "PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(256);",
      );
    }
    return { archived, deferred };
  }

  private compact(job: Job, events: EventRow[], record: ArchiveRow): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT * FROM transactions WHERE request_id=?")
        .get(job.request_id) as unknown as Job;
      if (
        !isTerminal(current.status) ||
        JSON.stringify(current) !== JSON.stringify(job)
      )
        throw new Error("Archive candidate changed");
      this.db
        .prepare("INSERT INTO transaction_archives VALUES (?,?,?,?,?)")
        .run(
          job.request_id,
          record.filename,
          record.sha256,
          record.stage_timings_json,
          Date.now(),
        );
      for (const event of events)
        this.db
          .prepare(
            "INSERT INTO archived_event_counts VALUES (?,1) ON CONFLICT(event_type) DO UPDATE SET count=count+1",
          )
          .run(event.event_type);
      this.db
        .prepare("DELETE FROM transaction_events WHERE request_id=?")
        .run(job.request_id);
      this.db
        .prepare("UPDATE transactions SET payload_json='{}' WHERE request_id=?")
        .run(job.request_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
