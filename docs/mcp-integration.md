# MCP integration

Run one persistent daemon for each managed checkout. Each agent's MCP client
connects to that daemon directly over HTTP or through a lightweight stdio proxy.
Starting a proxy does not create another Git worker or ledger.

## Start the daemon

Build the package, prepare a checkout whose `HEAD` matches the remote branch,
stop other Git writers, and run:

```sh
node /absolute/git-txd/dist/cli.js start \
  --repo /absolute/project --remote origin --branch main
```

Startup prints the loopback URL and private token-file path to stderr, and saves
them in `<stateDir>/endpoint.json`. Keep the daemon running under a service
manager if it needs to outlive agent sessions. Manage the supervisor's own
stdout/stderr capture separately from the daemon's rotating diagnostic log.

The configured checkout is the target regardless of an agent's current working
directory. Transaction paths are relative to that checkout. Confirm the repo,
branch, and remote with the operator before submitting a write.

## HTTP clients

Set the MCP server URL to `http://127.0.0.1:8787/mcp` (or the actual startup
port) and supply `Authorization: Bearer <token>` using the client's secret store.
The token is the contents of the startup token file. Never commit it, put it in
a URL, or paste it into shared instructions.

## Stdio clients

Configure the client's server command as `node`, with the following argument
array. Replace the example paths and URL with the actual installation values:

```json
[
  "/absolute/git-txd/dist/cli.js",
  "--url",
  "http://127.0.0.1:8787",
  "--token-file",
  "/absolute/private/state/token",
  "mcp-stdio"
]
```

The token value stays out of process arguments; the proxy reads the private
file. Alternatively, set `GIT_TXD_URL` and `GIT_TXD_TOKEN_FILE` in the client's
server environment and pass only the CLI path and `mcp-stdio` argument.

Multiple proxies share one queue. Do not configure each agent to run `start`.
Give the host enough tool-call time to cover queueing and Git execution. If its
wait ends early, retain the request ID and use the status/wait tools.

## Tools and verification

| Tool                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `git_commit_and_push`    | Submit explicit files with a stable request ID. |
| `git_queue_info`         | Observe repository health and pending requests. |
| `git_transaction_status` | Look up a durable outcome by ID.                |
| `git_wait_transaction`   | Wait on the same accepted request.              |

Test a new host in a disposable checkout with a local bare remote:

1. Call `git_queue_info` and confirm `READY` for the intended daemon.
2. Create one regular file and submit its exact path with operation `add`.
3. Confirm `SUCCEEDED`, `pushed: true`, and a commit SHA matching the remote.
4. Repeat the identical request and verify the same SHA and one new commit.
5. Restart the daemon with the same state directory and look up the original ID.
6. Connect a second client and verify both observe the same queue and outcome.

Queue inspection is not a reservation. A disconnect does not cancel Git work.
Preserve submitted files until the durable request settles. See the [API](api.md),
[agent contract](agent-instructions.md), and [recovery guide](operations.md).
