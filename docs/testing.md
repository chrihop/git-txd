# Testing

Tests create disposable repositories, private state directories, and local bare
remotes. They do not use an existing daemon or publish to an external repository.
Install native dependencies on each test platform rather than copying
`node_modules` between operating systems.

## Run the checks

Requires Node.js 24+, Git, Python, and a C/C++ toolchain for `fs-ext`. Proxy tests
also require OpenSSL and OpenSSH. Run from the repository root:

```sh
npm ci
npm run check
npm run format:check
npm test -- --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
npm run test:package
npm pack --dry-run --json
```

`npm test` builds first because process tests execute `dist/cli.js`.
The GitHub Actions matrix runs Node.js 24 and 26 on Linux and macOS.

`npm run test:package` builds a real tarball, installs it with production
dependencies in a temporary directory, and starts its installed CLI as a separate
daemon process. It verifies selected-file commits through the CLI, HTTP MCP and
stdio MCP, identical retries, rejected-push recovery across a graceful restart,
the original ledger inode and commit SHA, and preservation of unrelated edits.
It stops its daemon and removes the disposable installation afterward.

To exercise the actual package:

```sh
npm pack
npm exec --yes --package ./git-txd-0.1.0.tgz -- git-txd --version
```

## Coverage

- Twenty concurrent submissions, FIFO acceptance, deadlines, backpressure,
  selected-file isolation, and preservation of unrelated unstaged files.
- Identical retries, changed-payload conflicts, cancellation before execution,
  caller wait expiry, no-op requests, and author allowlisting.
- Unusual literal filenames, executable modes, deletions, unsupported file
  rejection, large trees, and streaming 24 MiB text/binary snapshot verification.
- Push rejection, lost acknowledgements, external writers, and safe recovery of
  an original transaction after real daemon SIGKILL at staging/commit/push.
- Inherited kernel locks and explicit operator alignment of already published
  fast-forward history.
- HTTP authentication, Host/Origin validation, body limits, official MCP SDK
  interoperability, packaged CLI calls, and multiple stdio proxies.
- Direct Git connections with rejecting proxy controls for HTTP, HTTPS,
  `git://`, and SSH-command selection.
- 10 MiB log rotation, five gzip archives, private-file checks, retention
  failures, schema migration, preserved unresolved rows, immutable archived
  outcomes, corrupt/missing archives, and crash-safe compaction.

SSH proxy tests exercise command selection and Git packet exchange through a
local harness. They do not establish compatibility with every SSH server,
credential helper, service manager, or MCP host. Verify those deployment
interfaces in your own environment using the [MCP checklist](mcp-integration.md).
