import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { LedgerArchive } from "./ledger-archive.js";
import { type Job, type Request, type Status } from "./model.js";

/** SQLite ledger. All updates and corresponding events commit together. */
export class Store {
  readonly db: DatabaseSync;
  readonly history: LedgerArchive;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > 2) {
      this.db.close();
      throw new Error("Unsupported ledger version");
    }
    if (version.user_version === 0)
      this.db.exec("PRAGMA auto_vacuum=INCREMENTAL;");
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS transactions (
        request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
        enqueue_seq INTEGER NOT NULL UNIQUE, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL, queue_deadline_ms INTEGER NOT NULL,
        started_at_ms INTEGER, expected_parent TEXT, commit_sha TEXT, remote_tip_sha TEXT,
        finished_at_ms INTEGER, last_error_code TEXT, last_error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS transactions_by_queue ON transactions(status, enqueue_seq);
      CREATE TABLE IF NOT EXISTS transaction_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
        event_type TEXT NOT NULL, event_at_ms INTEGER NOT NULL, details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transaction_archives (
        request_id TEXT PRIMARY KEY REFERENCES transactions(request_id), filename TEXT NOT NULL,
        sha256 TEXT NOT NULL, stage_timings_json TEXT NOT NULL, archived_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archived_event_counts (event_type TEXT PRIMARY KEY, count INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_request ON transaction_events(request_id,event_id);
      PRAGMA user_version=2;`);
    this.history = new LedgerArchive(this.db, dirname(path));
  }

  get(id: string): Job | undefined {
    return this.db
      .prepare("SELECT * FROM transactions WHERE request_id=?")
      .get(id) as unknown as Job | undefined;
  }

  jobs(): Job[] {
    return this.db
      .prepare("SELECT * FROM transactions ORDER BY enqueue_seq")
      .all() as unknown as Job[];
  }

  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO metadata VALUES (?,?)")
      .run(key, value);
  }

  insert(request: Request, digest: string, deadline: number): Job {
    this.atomic(() => {
      const next = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(enqueue_seq),0)+1 AS seq FROM transactions",
          )
          .get() as { seq: number }
      ).seq;
      this.db
        .prepare(
          `INSERT INTO transactions
        (request_id, request_digest, enqueue_seq, payload_json, status, accepted_at_ms, queue_deadline_ms)
        VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          request.request_id,
          digest,
          next,
          JSON.stringify(request),
          "QUEUED",
          Date.now(),
          deadline,
        );
      this.event(request.request_id, "QUEUED", {
        enqueue_seq: next,
        queue_deadline_ms: deadline,
      });
    });
    return this.get(request.request_id)!;
  }

  update(
    id: string,
    status: Status,
    fields: Partial<Omit<Job, "request_id" | "status">> = {},
  ): Job {
    if (this.history.record(id))
      throw new Error("Archived outcomes are immutable");
    const allowed = new Set([
      "started_at_ms",
      "expected_parent",
      "commit_sha",
      "remote_tip_sha",
      "finished_at_ms",
      "last_error_code",
      "last_error_message",
    ]);
    const entries = Object.entries(fields);
    if (entries.some(([key]) => !allowed.has(key)))
      throw new Error("Invalid ledger update");
    this.atomic(() => {
      this.db
        .prepare(
          `UPDATE transactions SET status=?${entries.map(([key]) => `,${key}=?`).join("")} WHERE request_id=?`,
        )
        .run(
          status,
          ...entries.map(([, value]) => value as string | number | null),
          id,
        );
      this.event(id, status, fields);
    });
    return this.get(id)!;
  }

  event(id: string, type: string, details: unknown = {}): void {
    // Repeated terminal retries must not recreate unbounded detailed history.
    if (this.history.record(id)) return;
    this.db
      .prepare(
        "INSERT INTO transaction_events (request_id,event_type,event_at_ms,details_json) VALUES (?,?,?,?)",
      )
      .run(id, type, Date.now(), JSON.stringify(details));
  }

  /** Resolve a retained payload for CLI operation inference, including archived adds/deletes. */
  payload(job: Job): string {
    return this.history.payload(job);
  }

  /** Compact age-qualified terminal history; caller must own the repository. */
  archive(
    cutoff: number,
    limit: number,
  ): { archived: number; deferred: number } {
    if (
      !Number.isFinite(cutoff) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error("Invalid archive policy");
    return this.history.run(cutoff, limit);
  }

  /** Stage summaries remain available even if an archive is taken offline. */
  stageTimings(id: string): unknown[] {
    const archived = this.history.record(id);
    if (archived) return JSON.parse(archived.stage_timings_json) as unknown[];
    const rows = this.db
      .prepare(
        "SELECT details_json FROM transaction_events WHERE request_id=? AND event_type='STAGE_TIMING' ORDER BY event_id",
      )
      .all(id) as { details_json: string }[];
    return rows.map((row) => JSON.parse(row.details_json) as unknown);
  }

  /** Cumulative counters include archived events. */
  eventCounts(): unknown[] {
    return this.db
      .prepare(
        "SELECT event_type,sum(count) AS count FROM (SELECT event_type,count(*) AS count FROM transaction_events GROUP BY event_type UNION ALL SELECT event_type,count FROM archived_event_counts) GROUP BY event_type ORDER BY event_type",
      )
      .all();
  }

  private atomic(action: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
