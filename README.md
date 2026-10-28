# git-txd

A durable Git transaction daemon for AI agents sharing one checkout.

Let agents work on separate files in parallel while one persistent worker queues
their commits and pushes. Agents submit explicit file lists through the CLI or
MCP, then recover the same transaction after a timeout or disconnect using its
request ID.

- **One Git writer:** FIFO staging, commit, and push through a shared daemon.
- **Selected files only:** preserve other agents' unstaged work.
- **Durable recovery:** SQLite records the request before Git execution and the
  commit SHA before publication; identical retries join the original request.
- **Shared interfaces:** CLI, HTTP MCP, and multiple stdio MCP proxies use the
  same worker and ledger.
- **Bounded diagnostics:** 10 MiB logs with five compressed archives; cold
  terminal history is archived while request identities remain reserved.

This is for cooperative agents that own disjoint files. Coordinate file
ownership separately and keep submitted files frozen until their request settles.
The daemon serializes Git writes; it does not resolve concurrent file edits.

## Install and start

Requires **Node.js 24+**, Git with `--pathspec-from-file` support, and macOS or
Linux. The `fs-ext` kernel-lock binding needs a C/C++ toolchain and Python for
installation. Windows and network filesystems are unsupported.
See [Linux setup and validation](docs/linux.md) for native build requirements
and a production-package smoke test.
For a persistent Linux daemon, use the [systemd user-service guide](docs/systemd.md).

```sh
git clone https://github.com/chrihop/git-txd.git
cd git-txd
npm ci
npm run build
node dist/cli.js start --repo /absolute/project --remote origin --branch main
```

The foreground daemon writes its loopback URL and private `token_file` path to
stderr. Local `HEAD` must initially match the existing remote branch. The index
must be clean; unrelated unstaged changes are allowed. The default state is in
the Git common directory under `git-txd/<repository-id>/state`.

In another shell, use the URL and token path printed at startup:

```sh
export GIT_TXD_URL=http://127.0.0.1:8787
export GIT_TXD_TOKEN_FILE=/absolute/path/from/startup/token
node dist/cli.js --json queue
node dist/cli.js --json commit --request-id agent-a-017 \
  --file src/agent-a.ts --file tests/agent-a.test.ts \
  --message 'Implement agent A feature'
node dist/cli.js --json status agent-a-017
node dist/cli.js --json wait agent-a-017 --wait-timeout-seconds 60
node dist/cli.js stop
```

`--file` infers add/modify/delete against `HEAD`. Repeated CLI submissions retain
the original operations by request ID, including after added files become
tracked. Explicit operations, author, and metadata can be supplied using
`commit --request-id ID --request-file request.json`. `--files0-from PATH`
accepts NUL-delimited UTF-8 filenames, including whitespace, newlines, and leading
dashes. Glob characters and noncanonical paths are deliberately rejected.

Freeze submitted files until the durable operation settles. A lost response or
`IN_PROGRESS` outcome does **not** cancel or roll back a transaction. Recover
using the same request ID. Never bypass the daemon with direct Git mutations.

## MCP

Connect an HTTP-capable host to `http://127.0.0.1:8787/mcp`, with
`Authorization: Bearer <contents of token_file>`. Keep the token in the host's
secret configuration. Tools:

- `git_commit_and_push`: blocking write to local history and the configured remote.
- `git_queue_info`: immediate observation; no reservation.
- `git_transaction_status`: durable outcome lookup.
- `git_wait_transaction`: bounded wait on an existing request.

For stdio-only hosts, run the forwarding adapter:

```sh
node /absolute/git-txd/dist/cli.js \
  --url http://127.0.0.1:8787 --token-file /absolute/private/token mcp-stdio
```

The adapter never opens SQLite or starts a worker. Multiple adapters are safe.
The implementation uses the official
[`@modelcontextprotocol/server` v2 handler](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html)
and Node adapter. Tests cover pinned 2026-07-28 and legacy SDK HTTP calls, CLI
parity, and multiple stdio clients. See the [MCP setup guide](docs/mcp-integration.md)
for client configuration and an integration checklist. Configure each host's
tool timeout to cover the daemon's queue and Git execution allowances.

## Configuration and recovery

Use `start --config config.json`; startup flags override the JSON values. This
implementation uses JSON configuration.
See [the example](docs/config.example.json), [API](docs/api.md),
[architecture](docs/architecture.md), [operator guide](docs/operations.md), and
[agent rules](docs/agent-instructions.md).

Daemon Git commands always bypass environment and Git proxy settings, SSH proxy
commands/jump hosts, and existing SSH shared connections. See
[direct Git connections](docs/operations.md#direct-git-connections).

Push failure preserves the local commit and pauses further branch transactions.
Resolve the cause and deliberately restart the service to revalidate/reconcile.
The daemon never force pushes, rebases, resets working files, or cleans files.
Commit and remote push are serialized operations, **not one atomic transaction**.

## Storage retention

Diagnostic logs rotate at **10 MiB**, retaining **five compressed archives**.
Idle maintenance archives completed request details after **30 days** while
permanently retaining request IDs, digests and outcomes for safe retries.
Unresolved transactions stay intact. See [retention and backups](docs/retention.md)
for configuration, crash behavior and storage limits.

## Development

```sh
npm run check
npm test -- --maxWorkers=1
npm run test:package
npm run format:check
npm pack --dry-run
```

Tests use disposable repositories and local bare remotes. They cover twenty
concurrent submissions, isolation, FIFO/deadlines/backpressure, idempotency,
push rejection and lost acknowledgements, real SIGKILL recovery, authentication,
and MCP/CLI/stdio interoperability. `npm test` builds first because process tests
execute the packaged CLI. The included GitHub Actions workflow checks Node.js
24 and 26 on Linux and macOS.

See [testing](docs/testing.md) for reproducible checks and coverage, and
[contributing](CONTRIBUTING.md) for the development workflow.

Install from source or a locally built npm tarball. This project has not been
published to the npm registry.
