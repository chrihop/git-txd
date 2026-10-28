# Contributing

Use Node.js 24+ on macOS or Linux. Install with `npm ci`, then run the checks in
[docs/testing.md](docs/testing.md). Keep changes focused and add regression tests
for behavior changes. Use disposable repositories and local remotes in tests.

Runtime code lives in `src/`, tests in `tests/`, and operator/client contracts in
`docs/`. Update the relevant contract when changing observable behavior.

Preserve request identity, fail-closed recovery, explicit path ownership, and
the distinction between a local commit and confirmed remote publication. Never
make a recovery path silently discard an unresolved transaction or recreate its
request ID.

Before opening a pull request, run type checks, tests, formatting, and
`npm pack --dry-run`. Inspect the package contents as well as the Git diff.
Exclude tokens, local configuration, logs, ledgers, real request payloads,
machine paths, and private deployment records from changes and examples.
