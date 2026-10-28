# systemd user service

Run one user service for one explicitly configured checkout. The daemon's
runtime, configuration, ledger, and token should live outside working files.
Install a packaged runtime rather than running an editable development build.

## Install the runtime and launcher

From a built source checkout, create a tarball and install it with production
dependencies. Use the same Node.js major version for installation and execution:

```sh
npm pack
npm install --prefix "$HOME/.local/share/git-txd/runtime" --omit=dev \
  ./git-txd-0.1.0.tgz
mkdir -p "$HOME/.local/bin" "$HOME/.config/git-txd"
```

Create a launcher that pins the absolute Node executable. This avoids depending
on an interactive shell or version-manager initialization inside systemd:

```sh
python3 - "$(command -v node)" \
  "$HOME/.local/share/git-txd/runtime/node_modules/git-txd/dist/cli.js" \
  "$HOME/.local/bin/git-txd" <<'PY'
import pathlib, shlex, sys
target = pathlib.Path(sys.argv[3])
if target.exists() or target.is_symlink():
    raise SystemExit("Inspect the existing launcher before replacing it")
target.write_text("#!/bin/sh\nexec " + shlex.join(sys.argv[1:3]) + ' "$@"\n')
target.chmod(0o755)
PY
```

Copy [the configuration example](config.example.json) to
`~/.config/git-txd/daemon.json`, choose the canonical checkout, branch and remote,
and add `"stateDir": "/absolute/private/state"`. Protect configuration with mode
0600 and state directories with mode 0700. Preserve that state location on every
restart; do not generate a new ledger to bypass a pause.

Git credentials must work noninteractively in the service environment. For a
single GitHub repository, a write-enabled deploy key limits access to that repo.
Keep the private key outside the checkout, retain strict host-key verification,
and configure its identity in OpenSSH. The daemon overrides SSH proxy commands
and `core.sshCommand`, so an SSH host alias can select the intended identity.
Verify the actual configured push URL before activating the service.

## Enable the service

Stop other Git writers and confirm the target branch, clean index, and matching
local/remote tips. Preserve unrelated unstaged edits.

```sh
mkdir -p "$HOME/.config/systemd/user"
cp contrib/systemd/git-txd.service "$HOME/.config/systemd/user/git-txd.service"
systemd-analyze --user verify "$HOME/.config/systemd/user/git-txd.service"
systemctl --user daemon-reload
systemctl --user enable --now git-txd.service
loginctl enable-linger "$(id -un)"
systemctl --user status git-txd.service
```

Enabling linger allows the user manager to run after logout and at boot. Some
systems require administrator authorization for this setting. Check with
`loginctl show-user "$(id -un)" -p Linger`.

The unit allows graceful shutdown before terminating remaining service
processes. Its fixed stop allowance covers the default Git/retry policy; raise
it if you configure longer execution bounds. The unit uses the system journal
for stdout/stderr; diagnostic log rotation inside the daemon remains separate.

```sh
journalctl --user -u git-txd.service -n 50 --no-pager
systemctl --user restart git-txd.service
systemctl --user stop git-txd.service
```

Only restart after checking the queue and preserving unresolved request IDs.
Follow the [operator recovery guide](operations.md) for a paused transaction.

## Connect MCP clients

Use the actual URL and token-file path recorded in `<stateDir>/endpoint.json`.
A local stdio client can run the pinned launcher with:

```sh
~/.local/bin/git-txd --url http://127.0.0.1:8787 \
  --token-file /absolute/private/state/token mcp-stdio
```

For a client on another computer, run that command through noninteractive SSH.
Use an absolute remote launcher path, disable PTY allocation, and configure
batch-mode authentication. Keep the HTTP listener on loopback; the MCP token
stays on the service host. Each SSH connection starts only a forwarding proxy,
while the systemd service owns the single Git worker and original ledger.

Codex supports command-based stdio entries in `~/.codex/config.toml`. Set a tool
timeout long enough for the queue and Git execution. See the
[official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [generic MCP setup](mcp-integration.md).

Validate a new installation by inspecting the queue, publishing only an
authorized explicit file list, checking its SHA against the remote, restarting
the service when idle, and retrying the identical request ID/payload. Confirm
the same SHA, one logical commit, unchanged ledger identity, and normal READY
health. Record deployment-specific paths and evidence privately, outside source
control.
