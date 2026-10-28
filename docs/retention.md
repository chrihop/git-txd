# Log rotation and ledger archival

Diagnostic logs and durable transaction identity have different retention rules.

## Diagnostic logs

The daemon writes structured transitions and maintenance events to
`<stateDir>/logs/daemon.log`. Before exceeding **10 MiB**, it compresses a segment
to `daemon.log.1.gz`, shifts older segments, and keeps **five gzip archives**.
The active file and each uncompressed segment are bounded to 10 MiB, including
oversized records. Logs use private directories and 0600 files. A custom
`logFile` configuration entry or `start --log-file /private/logs/daemon.log`
selects a different file in a private directory.

The daemon's repository lock provides single-writer ownership. Do not point two
services at the same log file, share it with a supervisor's stdout/stderr target,
or apply an external rename-based rotator to it. Startup handles an existing
oversized log with bounded memory and retains its last five segments.

Compressed bytes are flushed, published, and the directory flushed before the
active file is truncated. Interrupted rotation may duplicate diagnostic records;
it never changes transaction outcomes. A storage error emits one sanitized
stderr warning per daemon lifetime instead of an unbounded warning loop. SQLite
remains authoritative. Startup/CLI errors and the endpoint announcement still
use stderr; a service manager must manage its own stdout/stderr capture files.
Upgrading source does not retrofit rotation onto an already running service.

## Durable history

Configuration defaults:

```json
{
  "ledgerRetentionDays": 30,
  "ledgerArchiveBatchSize": 100
}
```

Once an hour, during an idle READY interval with no outstanding requests, the
coordinator considers at most 100 terminal requests older than 30 days. The five
eligible outcomes are `SUCCEEDED`, `NO_CHANGES`, `PRECOMMIT_FAILED`,
`QUEUE_EXPIRED`, and `CANCELLED_QUEUED`, with a recorded finish timestamp.
Queued, running, locally committed, pushing, reconciling, push-pending and
reconciliation-required requests retain their full payload and events regardless
of age. Maintenance never runs during Git execution or while paused/recovering.

For each eligible request:

1. Write its complete original transaction and ordered events to
   `<stateDir>/archives/<sha256(request_id)>.json.gz`.
2. Flush the file, atomically publish it, flush the directory, and verify its
   checksum through a private regular-file descriptor.
3. In one SQLite transaction, record the archive reference/checksum and stage
   timing summary, accumulate historical event counts, remove detailed live
   events, and replace only `payload_json` with `{}`.

The live transaction row permanently retains its **request ID, request digest,
queue sequence, status, timestamps, parent, commit/remote SHA, and error outcome**.
Status/wait/cancel and identical-payload MCP retries return the original outcome
without consulting archives. A different digest still raises
`REQUEST_ID_CONFLICT`; IDs and queue sequences are never reused. Repeated retries
of archived requests do not recreate detailed event rows. Stage timings and
cumulative event counters remain available.

CLI path/operation inference reads the original payload from its verified
archive, retaining original add/delete semantics after files change. A missing,
linked or corrupt archive fails with `ARCHIVE_UNAVAILABLE`; it never guesses a
new operation or frees the ID. Explicit original-payload retries and outcome
lookups remain safe even if that audit file is offline.

Archival failures leave the original live history intact. An interruption before
or during the SQLite transaction is recoverable from the original rows; a durable
orphan archive can be rebuilt on the next attempt. `queue` exposes
`archival_error`, and the rotating diagnostic log reports maintenance failures
and deferred requests. To bound memory, histories exceeding 10,000 events,
4 MiB of input payload/detail strings, or a 16 MiB encoded archive are deferred
without deletion and require operator review. They are not silently truncated.

## Disk usage, backup and compatibility

This bounds diagnostic logs and compresses bulky cold ledger history. It does
**not** impose a fixed cap on all durable state: identity/outcome rows and
compressed audit archives are retained indefinitely. Deleting those IDs would
make indefinite retry safety impossible. Archives are not subject to diagnostic
log rotation.

Back up the live SQLite database consistently **together with its archives**.
Retain the state-location pointer and repository binding. Do not delete the
ledger or substitute a new state directory to reclaim space.

Startup upgrades schema version 1 additively to version 2; existing transactions
and events remain intact. New ledgers enable incremental vacuum. Compaction
allows free SQLite pages to be reused; an existing version-1 file may not shrink
physically. Any full VACUUM of a legacy ledger requires an exclusive stopped
service maintenance window and a consistent backup. Do not downgrade an archived
ledger to a binary that does not understand schema 2.

Source publication, packaging, and installing/restarting a live daemon remain
separate actions. Tests use disposable repositories and never restart an existing service.
