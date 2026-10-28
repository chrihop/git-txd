#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client } from "./api.js";
import { startDaemon } from "./http.js";
import { createToolServer } from "./mcp.js";
import { TxdError } from "./model.js";

const program = new Command()
  .name("git-txd")
  .version("0.1.0")
  .option(
    "--url <url>",
    "daemon HTTP origin",
    process.env.GIT_TXD_URL ?? "http://127.0.0.1:8787",
  )
  .option(
    "--token-file <path>",
    "private bearer token file",
    process.env.GIT_TXD_TOKEN_FILE,
  )
  .option("--json", "machine-readable output");
const client = async (): Promise<Client> => {
  const options = program.opts();
  if (!options.tokenFile)
    throw new TxdError(
      "TOKEN_REQUIRED",
      "Use --token-file or GIT_TXD_TOKEN_FILE from daemon startup.",
    );
  return Client.fromFile(options.url as string, options.tokenFile as string);
};
const print = (result: Record<string, unknown>): void => {
  console.log(
    JSON.stringify(result, null, program.opts().json ? undefined : 2),
  );
  if (
    ["SUCCEEDED", "NO_CHANGES"].includes(String(result.status)) ||
    !result.status
  )
    return;
  if (
    result.repository_state === "PAUSED" ||
    [
      "PUSH_PENDING",
      "RECONCILIATION_REQUIRED",
      "PUSHING",
      "LOCAL_COMMITTED",
      "RECONCILING",
    ].includes(String(result.status))
  )
    process.exitCode = 4;
  else if (
    result.status === "IN_PROGRESS" ||
    result.status === "QUEUED" ||
    result.status === "RUNNING_PRECOMMIT"
  )
    process.exitCode = 3;
  else if (result.status !== "STOPPING") process.exitCode = 2;
};
program
  .command("start")
  .description("Run one foreground persistent daemon")
  .option("--config <file>", "JSON configuration file")
  .option("--repo <path>", "canonical repository root")
  .option("--remote <name>", "configured remote name")
  .option("--branch <branch>", "configured target branch")
  .option("--state-dir <path>", "durable private state directory")
  .option(
    "--log-file <path>",
    "rotating diagnostic log (10 MiB, five gzip archives)",
  )
  .option(
    "--accept-aligned-head",
    "operator: adopt an already published fast-forward after a pause",
  )
  .option("--port <port>", "loopback listening port", Number)
  .action(async (options) => {
    const config = options.config
      ? (JSON.parse(await readFile(options.config as string, "utf8")) as Record<
          string,
          unknown
        >)
      : {};
    for (const key of ["repo", "remote", "branch", "port"])
      if (options[key] !== undefined) config[key] = options[key];
    if (options.stateDir !== undefined) config.stateDir = options.stateDir;
    if (options.logFile !== undefined) config.logFile = options.logFile;
    if (options.acceptAlignedHead) config.acceptAlignedHead = true;
    const daemon = await startDaemon(config);
    daemon.logEvent({ event: "DAEMON_READY", url: daemon.url });
    console.error(
      JSON.stringify({
        event: "DAEMON_READY",
        url: daemon.url,
        token_file: daemon.tokenFile,
        ...daemon.coordinator.queue(),
      }),
    );
    const shutdown = (): void => {
      daemon.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
program
  .command("commit")
  .requiredOption("--request-id <id>")
  .option("--file <path...>", "explicit relative filenames")
  .option(
    "--files0-from <file>",
    "NUL-delimited UTF-8 filenames; trailing NUL required",
  )
  .option(
    "--request-file <file>",
    "full JSON request; files/message options are then ignored",
  )
  .option("--message <message>")
  .option("--agent-id <id>")
  .option("--wait-timeout-seconds <seconds>", "caller wait limit", Number)
  .action(async (options) => {
    const remote = await client();
    let request: Record<string, unknown>;
    if (options.requestFile)
      request = JSON.parse(
        await readFile(options.requestFile as string, "utf8"),
      ) as Record<string, unknown>;
    else {
      const paths = (options.file ?? []) as string[];
      if (options.files0From) {
        const input = await readFile(options.files0From as string, "utf8");
        if (!input.endsWith("\0"))
          throw new TxdError(
            "INVALID_PATH_FILE",
            "Filename list must end in NUL.",
          );
        paths.push(...input.slice(0, -1).split("\0"));
      }
      const described = await remote.call("describe", {
        paths,
        request_id: options.requestId,
      });
      request = {
        files: described.files,
        message: options.message,
        metadata: options.agentId ? { agent_id: options.agentId } : {},
      };
    }
    request.request_id = options.requestId;
    if (options.waitTimeoutSeconds !== undefined)
      request.wait_timeout_seconds = options.waitTimeoutSeconds;
    print(await remote.commitAndPush(request));
  });
for (const command of ["queue", "health", "stop"]) {
  program.command(command).action(async () => {
    print(await (await client()).call(command));
  });
}
for (const command of ["status", "cancel", "wait"]) {
  program
    .command(`${command} <request-id>`)
    .option("--wait-timeout-seconds <seconds>", "caller wait limit", Number)
    .action(async (id: string, options) => {
      print(
        await (
          await client()
        ).call(command, {
          request_id: id,
          wait_timeout_seconds: options.waitTimeoutSeconds ?? null,
        }),
      );
    });
}
program
  .command("mcp-stdio")
  .description("Forward MCP tools to an existing daemon; never start a worker")
  .action(async () => {
    const remote = await client();
    serveStdio(() => createToolServer(remote));
  });
program.parseAsync().catch((error: unknown) => {
  const safe =
    error instanceof TxdError
      ? error
      : new TxdError(
          "COMMAND_FAILED",
          "Command failed. If a submission may have reached the daemon, inspect its request ID.",
        );
  console.error(
    JSON.stringify({ error_code: safe.code, error_message: safe.message }),
  );
  process.exitCode = safe.code === "REPOSITORY_PAUSED" ? 4 : 2;
});
