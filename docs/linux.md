# Linux setup and validation

`git-txd` supports Linux amd64 with Node.js 24 or newer and a local filesystem.
Install Git, Python 3, and a C/C++ build toolchain before installing dependencies.
The `fs-ext` dependency builds a native binding for kernel file locks. OpenSSH
and OpenSSL are also required for the full transport test suite.

For Debian/Ubuntu, the native build prerequisites are:

```sh
sudo apt-get install git python3 build-essential openssh-client openssl
```

Install Node.js 24+ using your preferred distribution or version manager, then
verify that the intended runtime is on `PATH`:

```sh
node --version
node -p 'process.platform + "/" + process.arch'
```

For Linux amd64, the second command should print `linux/x64`. Do not copy
`node_modules` from macOS, another CPU architecture, or a different Node.js major
version. Native modules must be installed or rebuilt for the runtime that will
run the daemon. If npm reports that an install script needs approval, review the
`fs-ext` native build under your installation policy before starting the daemon.

## Install and validate

```sh
git clone https://github.com/chrihop/git-txd.git
cd git-txd
npm ci
npm run build
npm run check
npm run format:check
npm test -- --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
npm run test:package
```

The package test builds a tarball and installs it with production dependencies.
It runs the installed CLI daemon, exercises CLI and both MCP transports, rejects
a push at a disposable remote, and restarts the daemon to confirm the original
ledger and commit recover without duplication. Everything uses temporary local
repositories; no existing service or remote repository is used.

To run against your own checkout after these checks:

```sh
node dist/cli.js start --repo /absolute/project --remote origin --branch main
```

The local branch and existing remote target must initially match, and the index
must be clean. Other agents may keep unrelated unstaged edits. Coordinate file
ownership and use the daemon as the only Git writer.

## Service environments

Use the [systemd user-service guide](systemd.md) and included unit template for
a persistent installation with a separate packaged runtime and MCP clients.

A service manager does not necessarily load interactive shell profiles. Use an
absolute Node.js executable path and an absolute CLI path in the service command,
particularly when Node.js is installed with a version manager. Supply required
SSH-agent access explicitly, and verify credentials using a disposable target
before managing an important checkout.

Keep the ledger and archives on a local filesystem, retain the same state
directory across restarts, and give graceful shutdown enough time to finish the
active transaction. Configure rotation for the service manager's own captured
stdout/stderr separately. See the [operator guide](operations.md),
[MCP setup](mcp-integration.md), and [retention rules](retention.md).
