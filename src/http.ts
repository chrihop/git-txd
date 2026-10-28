import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { Coordinator } from "./coordinator.js";
import { createToolServer } from "./mcp.js";
import { requestSchema, type StoredRequest, TxdError } from "./model.js";
import { RotatingLog } from "./rotating-log.js";

/** Start authenticated MCP/control HTTP endpoints sharing exactly one coordinator. */
export const startDaemon = async (input: unknown) => {
  const coordinator = await Coordinator.open(input);
  let log: RotatingLog;
  try {
    log = new RotatingLog(
      coordinator.config.logFile ??
        join(coordinator.repository.stateDir, "logs", "daemon.log"),
    );
  } catch (error) {
    await coordinator.close();
    throw error;
  }
  let logFailureReported = false;
  const logEvent = (event: unknown): void => {
    try {
      log.write(event);
    } catch {
      if (!logFailureReported) {
        logFailureReported = true;
        console.error(
          JSON.stringify({
            event: "LOG_WRITE_FAILED",
            message:
              "Inspect diagnostic log storage; ledger remains authoritative.",
          }),
        );
      }
    }
  };
  let token: string;
  const tokenFile = join(coordinator.repository.stateDir, "token");
  try {
    try {
      await writeFile(tokenFile, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new TxdError(
        "TOKEN_PERMISSIONS",
        "Token file must be a regular file with mode 0600.",
      );
    token = (await readFile(tokenFile, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new TxdError(
        "INVALID_TOKEN",
        "Token file must contain 32 random bytes encoded as hex.",
      );
  } catch (error) {
    await coordinator.close();
    log.close();
    throw error;
  }
  const mcp = createMcpHandler(() => createToolServer(coordinator), {
    maxRequestBodySize: 1024 * 1024,
  });
  coordinator.events.on("transition", logEvent);
  coordinator.events.on("diagnostic", logEvent);
  const handleMcp = toNodeHandler(mcp, { maxRequestBodySize: 1024 * 1024 });
  let port = coordinator.config.port;
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const safe =
        error instanceof TxdError
          ? error
          : new TxdError(
              "INVALID_REQUEST",
              "Invalid request or service failure.",
            );
      if (!response.headersSent)
        send(response, safe.code === "BODY_TOO_LARGE" ? 413 : 400, {
          error_code: safe.code,
          error_message: safe.message,
        });
      else response.destroy();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await coordinator.close();
      server.closeAllConnections();
      await stopped;
      await mcp.close();
      log.close();
    })();
    return closing;
  };
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (
      !allowedHosts.includes(request.headers.host ?? "") ||
      (request.headers.origin !== undefined &&
        !allowedHosts
          .map((host) => `http://${host}`)
          .includes(request.headers.origin))
    ) {
      send(response, 403, {
        error_code: "FORBIDDEN_ORIGIN",
        error_message: "Host or Origin is not allowed.",
      });
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      send(response, 401, {
        error_code: "UNAUTHORIZED",
        error_message: "Local bearer token required.",
      });
      return;
    }
    if (request.url === "/mcp") {
      await handleMcp(
        {
          method: request.method ?? "POST",
          url: request.url,
          headers: request.headers,
          [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
        },
        response,
      );
      return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/api/")) {
      send(response, 404, {
        error_code: "NOT_FOUND",
        error_message: "Unknown endpoint.",
      });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0] !== "application/json")
      throw new TxdError("CONTENT_TYPE", "Use application/json.");
    const body = await readBody(request);
    const abort = new AbortController();
    const disconnected = (): void => abort.abort();
    response.once("close", disconnected);
    const route = request.url.slice("/api/".length);
    let result: Record<string, unknown>;
    try {
      if (route === "commit")
        result = await coordinator.commitAndPush(body, abort.signal);
      else if (route === "queue" || route === "health")
        result = coordinator.queue();
      else if (route === "describe") {
        const { paths, request_id } = z
          .strictObject({
            paths: z.array(z.string()).min(1).max(1000),
            request_id: requestSchema.shape.request_id.optional(),
          })
          .parse(body);
        const previous = request_id
          ? coordinator.store.get(request_id)
          : undefined;
        if (previous) {
          const { snapshot_sizes: _sizes, ...logical } = JSON.parse(
            coordinator.store.payload(previous),
          ) as StoredRequest;
          const original = requestSchema.parse(logical);
          result = {
            files: paths.map(
              (path) =>
                original.files.find((file) => file.path === path) ?? {
                  path,
                  operation: "modify",
                },
            ),
          };
        } else result = { files: await coordinator.repository.describe(paths) };
      } else if (route === "stop") {
        send(response, 200, { status: "STOPPING" });
        setImmediate(() => {
          close().catch(() => {
            process.exitCode = 1;
          });
        });
        return;
      } else {
        const params = z
          .strictObject({
            request_id: requestSchema.shape.request_id,
            wait_timeout_seconds: requestSchema.shape.wait_timeout_seconds,
          })
          .parse(body);
        if (route === "status") result = coordinator.status(params.request_id);
        else if (route === "wait")
          result = await coordinator.wait(
            params.request_id,
            params.wait_timeout_seconds,
            abort.signal,
          );
        else if (route === "cancel")
          result = coordinator.cancel(params.request_id);
        else throw new TxdError("NOT_FOUND", "Unknown endpoint.");
      }
      send(response, 200, result);
    } finally {
      response.off("close", disconnected);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    port = (server.address() as { port: number }).port;
  } catch (error) {
    await coordinator.close();
    await mcp.close();
    log.close();
    throw error;
  }
  const url = `http://127.0.0.1:${port}`;
  await writeFile(
    join(coordinator.repository.stateDir, "endpoint.json"),
    JSON.stringify({ url, token_file: tokenFile }),
    { mode: 0o600 },
  );
  return { coordinator, server, url, tokenFile, close, logEvent };
};

const send = (
  response: ServerResponse,
  code: number,
  result: unknown,
): void => {
  if (response.destroyed) return;
  response.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(result));
};
const readBody = async (request: IncomingMessage): Promise<unknown> => {
  if (Number(request.headers["content-length"]) > 1024 * 1024)
    throw new TxdError("BODY_TOO_LARGE", "Request body exceeds 1 MiB.");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        exceeded = true;
        chunks.length = 0;
        reject(new TxdError("BODY_TOO_LARGE", "Request body exceeds 1 MiB."));
      } else chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("aborted", () =>
      reject(new TxdError("DISCONNECTED", "Request upload disconnected.")),
    );
    request.once("end", () => {
      if (exceeded) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          new TxdError("INVALID_JSON", "Request body must be valid JSON."),
        );
      }
    });
  });
};
