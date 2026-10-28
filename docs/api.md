# API and deadlines

All HTTP endpoints require the private bearer token and an allowed loopback
Host. If Origin is present, it must equal a permitted loopback origin on the
daemon's port. Bodies are limited to 1 MiB and requests to 1,000 paths.

## Request

```json
{
  "request_id": "agent-a-017",
  "files": [{ "path": "src/feature.ts", "operation": "modify" }],
  "message": "Implement feature",
  "metadata": { "agent_id": "agent-a", "task_id": "feature-017" },
  "wait_timeout_seconds": 60
}
```

`operation` is `add`, `modify`, or `delete`. An add must be untracked; a modify
must be tracked and present; a delete must be tracked and absent. Rename means
delete plus add. No-op modifies return `NO_CHANGES` without making a commit.
An optional `{name,email}` author must match a daemon allowlist entry exactly.
Committer identity is configured at startup. Branches, URLs, flags, signing, and
hooks cannot be selected by the request. Unknown input properties are rejected.

For admission adapters, non-deleted files may include an expected `sha256`
(64 lowercase hexadecimal digits) and `mode` (`100644` or `100755`). The daemon
checks these constraints against the working file before staging, the staged
blob before committing, and the durable commit before publication. A changed
snapshot fails with `SNAPSHOT_CHANGED`; an unexpected committed snapshot pauses
reconciliation. The constraints are part of the idempotent logical request.

Present files are limited to 1 GiB each. Admission streams any supplied hash and
records byte lengths as internal `snapshot_sizes` ledger metadata. Callers cannot
supply that property; it is excluded from the logical request digest. Staged and
committed hashed blobs are read in hash-only mode, with exact length and SHA-256
checks and no captured blob output. Ordinary command output remains capped at
16 MiB. Legacy queued requests without sizes are revalidated before execution;
a hashed committed snapshot without an admitted size requires operator recovery
rather than an inferred successful verification.

Queue expiry and queued cancellation apply only before a transaction first enters
Git execution. Recovery retains that first-start identity when an unchanged base
allows the original precommit transaction to resume. Short-lived index locks are
waited on for at most five seconds; staging and commit retry at most twice after
verifying the same HEAD, the expected index subset and original file constraints.
Staging requires a clean index; commit preserves its verified selected staging.
Git reports index-lock contention as `INDEX_LOCKED` without exposing raw stderr. The daemon never
removes another process's index lock or silently adopts external history.

MCP tools expose structured output and matching text JSON. Domain rejection
uses `isError` with a stable `error_code`; durable transaction outcomes remain
ordinary structured results. `git_commit_and_push` is annotated as a write to
an external system. Status/wait/queue tools are read-only observations.

## Control API

These are authenticated `POST /api/<operation>` JSON requests, primarily for
the bundled CLI. There is no asynchronous submission endpoint.

| Operation         | Body                                  | Response                          |
| ----------------- | ------------------------------------- | --------------------------------- |
| `commit`          | Transaction request                   | Blocking transaction result       |
| `queue`, `health` | `{}`                                  | Shared queue and health           |
| `status`          | `{request_id}`                        | Durable result                    |
| `wait`            | `{request_id, wait_timeout_seconds?}` | Bounded existing-job wait         |
| `cancel`          | `{request_id}`                        | Cancels only `QUEUED` jobs        |
| `describe`        | `{paths, request_id?}`                | Operations inferred for CLI paths |
| `stop`            | `{}`                                  | Graceful daemon shutdown          |

MCP lives at `/mcp` and uses the official v2 request-based HTTP handler, with
stateless legacy compatibility. Standalone GET event streams are not served.

## Timeouts and cancellation

At durable acceptance, with `Q` outstanding requests ahead:

```text
queue_allowance = min(maxQueueMs, max(minQueueMs, (Q + 1) * slotMs))
queue_deadline = accepted_at + queue_allowance
```

The deadline never extends. Expired queued work becomes `QUEUE_EXPIRED` without
Git effects, including while paused. Queue inspection does not reserve a slot.
Running work is governed by separate subprocess limits; expiration of a caller
wait does not kill it. Default waits include the remaining queue allowance,
Git allowance, push/reconciliation attempts, and margin, capped at one hour.
An explicit wait can range from zero to one hour.

`IN_PROGRESS` is a caller response, not a durable state. It includes
`request_id`, `durable_state`, deadline, and commit SHA when known. Inspect
status before editing submitted paths again. A disconnected HTTP or MCP waiter
is released; the durable operation is retained because a lost connection cannot
reliably distinguish intentional cancellation from network loss. Use the
authenticated CLI `cancel ID` for explicit queued cancellation. Cancelling an
active request leaves it running/reconciling. Reattach with `wait ID`.

| CLI exit | Meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| 0        | `SUCCEEDED`, `NO_CHANGES`, or successful observation/control command     |
| 2        | Invalid/unaccepted request, queue expiry/cancellation, precommit failure |
| 3        | Accepted request remains queued/running or caller wait ended             |
| 4        | Push unresolved or repository paused                                     |

No nonzero exit implies rollback. A published transaction may report
`SUCCEEDED` alongside a paused repository if an external writer advanced the
remote afterward. Queue output includes active stage, pending acceptance
sequence/deadlines, approximate wait, event counts, and last confirmed/local SHAs.
