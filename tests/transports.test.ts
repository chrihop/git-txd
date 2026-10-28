import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  Client as McpClient,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect, it, vi } from "vitest";
import { Client, resultSchema } from "../src/api.js";
import { startDaemon } from "../src/http.js";
import { fixture, git, request } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const setup = async () => {
  const f = await fixture();
  cleanup.push(f.remove);
  const daemon = await startDaemon(f.config);
  cleanup.push(daemon.close);
  const token = (await readFile(daemon.tokenFile, "utf8")).trim();
  return { ...f, daemon, token, client: new Client(daemon.url, token) };
};

it.each(["legacy", "modern"] as const)(
  "serves %s SDK HTTP calls and CLI clients through one ledger",
  async (mode) => {
    const f = await setup();
    const mcp = new McpClient(
      { name: "fixture", version: "1.0" },
      {
        versionNegotiation: {
          mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy",
        },
      },
    );
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${f.daemon.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${f.token}` } },
      }),
    );
    cleanup.push(() => mcp.close());
    const tools = await mcp.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "git_commit_and_push",
    );
    expect(
      tools.tools.find((tool) => tool.name === "git_commit_and_push")!
        .annotations?.readOnlyHint,
    ).toBe(false);
    await writeFile(join(f.repo, "mcp.txt"), "mcp");
    await writeFile(join(f.repo, "cli.txt"), "cli");
    const [mcpResult, cliResult] = await Promise.all([
      mcp.callTool({ name: "git_commit_and_push", arguments: request("mcp") }),
      exec(process.execPath, [
        resolve("dist/cli.js"),
        "--url",
        f.daemon.url,
        "--token-file",
        f.daemon.tokenFile,
        "--json",
        "commit",
        "--request-id",
        "cli",
        "--file",
        "cli.txt",
        "--message",
        "Add cli",
      ]),
    ]);
    expect(resultSchema.parse(mcpResult.structuredContent).status).toBe(
      "SUCCEEDED",
    );
    const output = JSON.parse(cliResult.stdout);
    expect(output.status).toBe("SUCCEEDED");
    const retry = await exec(process.execPath, [
      resolve("dist/cli.js"),
      "--url",
      f.daemon.url,
      "--token-file",
      f.daemon.tokenFile,
      "--json",
      "commit",
      "--request-id",
      "cli",
      "--file",
      "cli.txt",
      "--message",
      "Add cli",
    ]);
    expect(JSON.parse(retry.stdout).commit_sha).toBe(output.commit_sha);
    expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe(
      "2",
    );
    const recovered = await mcp.callTool({
      name: "git_transaction_status",
      arguments: { request_id: "cli" },
    });
    expect(resultSchema.parse(recovered.structuredContent).commit_sha).toBe(
      output.commit_sha,
    );
  },
  60000,
);

it("uses multiple stdio proxies without creating another repository owner", async () => {
  const f = await setup();
  const clients = [
    new McpClient({ name: "stdio-a", version: "1" }),
    new McpClient({ name: "stdio-b", version: "1" }),
  ];
  for (const client of clients) {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve("dist/cli.js"),
          "--url",
          f.daemon.url,
          "--token-file",
          f.daemon.tokenFile,
          "mcp-stdio",
        ],
        stderr: "pipe",
      }),
    );
    cleanup.push(() => client.close());
  }
  await writeFile(join(f.repo, "stdio.txt"), "stdio");
  const result = await clients[0]!.callTool({
    name: "git_commit_and_push",
    arguments: request("stdio"),
  });
  const observed = await clients[1]!.callTool({
    name: "git_transaction_status",
    arguments: { request_id: "stdio" },
  });
  expect(resultSchema.parse(result.structuredContent).status).toBe("SUCCEEDED");
  expect(resultSchema.parse(observed.structuredContent).commit_sha).toBe(
    resultSchema.parse(result.structuredContent).commit_sha,
  );
  expect(f.daemon.coordinator.store.jobs()).toHaveLength(1);
}, 60000);

it("requires authentication and rejects foreign Host/Origin and oversized bodies", async () => {
  const f = await setup();
  const url = `${f.daemon.url}/api/queue`;
  const headers = {
    authorization: `Bearer ${f.token}`,
    "content-type": "application/json",
  };
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, origin: "https://attacker.example" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const call = httpRequest(
      url,
      { method: "POST", headers: { ...headers, host: "attacker.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    call.on("error", reject);
    call.end("{}");
  });
  expect(foreignHost).toBe(403);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ large: "x".repeat(1024 * 1024) }),
      })
    ).status,
  ).toBe(413);
  expect((await f.client.queue()).repository_state).toBe("READY");
});

it("keeps a durable operation after HTTP loss and safely cancels only queued work", async () => {
  const f = await setup();
  for (const id of ["disconnected", "queued"])
    await writeFile(join(f.repo, `${id}.txt`), id);
  const commit = f.daemon.coordinator.repository.commit.bind(
    f.daemon.coordinator.repository,
  );
  vi.spyOn(f.daemon.coordinator.repository, "commit").mockImplementationOnce(
    async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await commit(input);
    },
  );
  const abort = new AbortController();
  const disconnected = f.client
    .commitAndPush(request("disconnected"), abort.signal)
    .catch(() => undefined);
  while (!f.daemon.coordinator.store.get("disconnected"))
    await new Promise((resolve) => setTimeout(resolve, 5));
  abort.abort();
  await disconnected;
  await f.client.commitAndPush({
    ...request("queued"),
    wait_timeout_seconds: 0,
  });
  expect((await f.client.call("cancel", { request_id: "queued" })).status).toBe(
    "CANCELLED_QUEUED",
  );
  expect((await f.client.wait("disconnected")).status).toBe("SUCCEEDED");
  expect(await git(f.repo, "rev-list", "--count", `${f.base}..HEAD`)).toBe("1");
});
