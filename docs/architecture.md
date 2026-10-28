# Architecture

`Coordinator` owns one `Repository`, one SQLite `Store`, and one asynchronous
worker loop. HTTP creates per-request MCP facades over this shared object.
The CLI and stdio proxy use authenticated control HTTP; they never own Git state.

## Admission and execution

Syntax, paths, author policy, and service health are validated before acceptance.
A short SQLite transaction inserts the request, monotonic acceptance sequence,
frozen queue deadline, and initial event. No SQLite transaction spans an await.
Node's single event loop serializes admission after filesystem validation;
acceptance rechecks IDs and capacity after that validation yields.

The digest includes repository/branch/remote identity, sorted path/operation
pairs, message, and author. Metadata and caller wait timeout do not affect the
logical commit. IDs and compact outcomes are retained indefinitely; bulky terminal
history can be archived without ID reuse. The same ID with another digest is rejected. Retries join the original
operation, even while the repository is paused.

The worker takes the oldest eligible request, claims it synchronously, checks
the branch/index/expected `HEAD` and remote baseline, then persists the parent
before staging. Literal NUL-delimited pathspecs select explicit regular files.
The staged set and committed set must stay within the request. Commit messages
contain exactly one protected `Git-Tx-Id` trailer. Hooks and signing are disabled.

The commit SHA is journaled before remote work. Publication is verified using
the **push URL**, avoiding a mistaken comparison with a distinct fetch URL.
Only the explicit SHA-to-configured-branch refspec is pushed; automatic tags and
mirror behavior are disabled. Every local command has a deadline. Ordinary
captured stdout is capped at 16 MiB; snapshot reads hash the stream without
capturing it and stop if the admitted length is exceeded (at most 1 GiB per
file). Working-file hash reads are streamed with the same length and deadline
constraints. The daemon persists admitted lengths in the request payload while
keeping the public strict schema and idempotency digest unchanged.

Timeout, cancellation and output overflow request termination of the owned Git
process group. Completion records whether child close was observed. A failed
signal or unobserved close latches a typed custody failure, blocks further Git
commands, and pauses the coordinator before cleanup or retry. The inherited
kernel lock remains effective for surviving Git children.

## Durability and exclusive ownership

SQLite uses WAL and `synchronous=FULL`. Each state update and its event share a
database transaction. Schema version 2 adds archive references, summaries and
historical counters to version-1 ledgers without changing unresolved rows.
Detailed terminal history is copied to durable compressed archives before atomic
compaction. See [retention](retention.md) for exact boundaries and limitations.

The kernel `flock` file is anchored in the Git common directory, keyed by the
canonical worktree and common-directory paths. It remains on disk and is never
unlinked. A PID file or lease is not used. Changing `stateDir` cannot bypass
ownership or create a fresh ledger: a persistent pointer binds each worktree to
its original state directory.

Git subprocesses inherit the locked descriptor. If the daemon dies while Git
is still active, the surviving Git process holds the lock until it exits. A
paused daemon also retains the lock. Process tests verify both behaviors.
OS process teardown releases ownership after all inherited descriptors close.

## Recovery

Startup enters `RECOVERING` before serving writes. A request staged without a
commit is cleaned using **only its staged paths**, with the working files left
intact, and requeued under its original deadline. A commit made before its SHA
was journaled is correlated using the intended parent, unique trailer, and
authorized changed paths. Unexpected local history or index contents pause.

An unresolved transaction is inspected before another job can commit. An exact
remote match succeeds. A known unchanged remote base permits bounded non-force
retries of the existing SHA. A remote descendant confirms publication but pauses
the checkout because an external writer advanced it. Other divergence, missing
refs, inspection failures, or uncertain outcomes preserve history and pause.

## Boundaries

This service assumes cooperative agents with disjoint file ownership, frozen
submitted files, trusted repository configuration/attributes, and exclusive
daemon Git writes. Hooks are disabled, but the service is not a sandbox for
malicious Git configurations, credential helpers, remote helpers, or filters.
It does not arbitrate file ownership, prevent unrestricted shell access, or make
commit/push atomic. Symlinks, submodules, directories, non-UTF-8 filenames, NFS,
and Windows are unsupported. The initial target branch must already exist and
match local `HEAD`; importing unpublished local history requires operator work.
