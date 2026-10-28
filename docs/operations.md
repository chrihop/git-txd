# Operator guide

## Startup and service lifecycle

First establish a normal checkout of the intended branch with local `HEAD`
matching its existing remote branch. Preserve any unrelated unstaged work, and
resolve existing staging/merge/rebase state before enabling the daemon. Stop
other Git writers. Start one foreground process under your service manager:

```sh
git-txd start --config /private/path/git-txd.json
```

The daemon binds only to `127.0.0.1`. It generates a 0600 bearer token within its
0700 state directory, and prints the endpoint and token **path**, never its
contents. Keep the token out of source control, command-line arguments, and
shared logs. Configure MCP host bearer headers using the host's secret store.
Every control endpoint is authenticated, including health/status and shutdown.

For a custom state directory, pass `stateDir` in configuration or `--state-dir`.
It must be a private directory outside working files. Default state lives in Git
metadata. Do not delete the ledger, move its pointer, unlink the lock file, or
launch a fresh state directory to work around a pause: doing so loses request
identity and can cause duplicate commits. State-location migration is not an
automated operation in v1.

`SIGINT`, `SIGTERM`, and authenticated `git-txd stop` stop admissions and let
active Git work settle before closing the database and lock. Queued work stays
durable for restart under its original deadlines. A service manager should
allow enough graceful-stop time for configured subprocess/retry bounds. On a
forced kill, a surviving Git child retains ownership until it exits; a restart
may briefly report `ALREADY_RUNNING`. Do not delete that lock.

## Diagnosis

`git-txd --json health`, `queue`, and `status ID` expose service state and safe
error codes. The SQLite `transactions` table stores acceptance, start/finish,
parent, commit, observed remote SHA, and failure reason. `transaction_events`
stores every durable transition, staging checkpoint, duplicate request, retry,
and per-stage timing until terminal history is archived. Status retains recorded
stage timings afterward. The rotating daemon log emits structured transitions without Git stderr or
remote URLs. Git output is not copied to tool responses because it can contain
credentials. Use trusted operator tools for further network diagnosis.

See [log rotation and ledger archival](retention.md) for the 10 MiB/five-gzip log
policy, default 30-day history archival, permanent retry records, backup scope,
and maintenance failure handling. Supervisor stdout/stderr capture is separate.

`PRECOMMIT_DIAGNOSTIC` and `CUSTODY_DIAGNOSTIC` events retain an allowlisted
error kind, errno, stage and immediate cause code. Child custody includes only
PID, observed-close and inherited-lock flags. Arbitrary messages, stacks,
arguments, URLs and getter-derived fields are omitted. A
`GIT_TERMINATION_FAILED` or `GIT_CUSTODY_UNCONFIRMED` result preserves staging
and pauses the queue; reconcile the original child and transaction before
restarting the same ledger. Never clear an index to bypass this state.

## Paused repository

1. Keep the daemon paused and inspect `status ID`, health, and the durable ledger.
2. Stop agents from submitting or editing the affected files.
3. Stop the daemon before any manual Git mutation. Preserve uncommitted files,
   staged content, transaction commit SHAs, and the database.
4. Fix the cause: credentials/network, remote rejection, branch change, dirty
   index, or external remote history. Inspect `HEAD` and the configured remote
   target explicitly. Publication may already have happened.
5. Deliberately restart the same configuration/state directory. The startup gate
   validates branch/index/history and reconciles the original commit before
   processing later jobs.

If the remote still points to the previous confirmed base, restart retries the
existing local transaction commit using a non-force push. If it already points
to that commit, restart records success without another commit. A remote
descendant proves publication but requires controlled local history alignment;
divergence or rewritten history requires operator integration. Such integration
may need a separate controlled checkout after all agents stop editing. There is
no automatic rebase/reset or permissive resume endpoint.

After deliberate manual alignment of local `HEAD` to a remote fast-forward,
restart once with `--accept-aligned-head`. This operator-only startup flag
requires an existing paused ledger, a clean index, local/remote equality, and
ancestry preserving the previous expected head and any unresolved recorded
transaction. It records the adopted baseline in the journal. It cannot adopt a
rewrite, discard an unresolved commit, or resolve an unjournaled ambiguous
commit. Subsequent normal starts should omit the flag. Without it, unexpected
local `HEAD` changes continue to fail closed.

System/global Git configuration and inherited `GIT_*` environment variables are
disabled for consistent command policy. Use a trusted repository credential
configuration or SSH agent when the remote needs authentication.

## Direct Git connections

All daemon Git subprocesses connect directly. Proxy environment variables are
removed case-insensitively, and `no_proxy`/`NO_PROXY` are set to `*`. Each command
disables `http.proxy` and clears effective URL-specific HTTP and per-remote proxy
settings (including included/worktree configuration) through subprocess-only
overrides. This also prevents proxy credential prompts. Repository configuration
files and the parent environment are not changed.

Native `git://` transport ignores `core.gitProxy` and inherited proxy commands.
SSH uses OpenSSH with `ProxyCommand=none`, `ProxyJump=none`, and connection sharing
disabled so it cannot reuse an existing proxied master connection. Repository
`core.sshCommand` and inherited SSH-command overrides are superseded. Configure
SSH host aliases, identity files, agent access, and host-key verification in the
normal SSH configuration; those settings remain active.

This fixed policy covers both MCP and CLI transactions, including startup remote
checks, pushes, and reconciliation fetches. It does not change operating-system
network routing, VPNs, or transparent network interception.

A dirty index outside the authorized paths is left intact and blocks recovery.
A stale Git `index.lock` is never removed automatically; determine whether a
Git process still owns it before operator cleanup. An interrupted staging-only
job can clean only its own staged paths without changing working-file contents.

## Deployment checks

Tests cover local bare remotes and the official SDK on macOS/Linux. Configure
the intended Codex/other MCP hosts and verify authentication, protocol support,
and tool timeout allowances in that environment before production use. Agents
with arbitrary shell access can bypass the policy; enforce exclusive Git writes
outside this application if the environment requires that guarantee.

Dependencies are pinned in `package-lock.json`. Review native install scripts
and use `npm ci`; do not transfer macOS `node_modules` to Linux. Build and package
with `npm run check`, `npm test`, and `npm pack`. Publishing and installation into
user MCP configuration are separate operator actions.
