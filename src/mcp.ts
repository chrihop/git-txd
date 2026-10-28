import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { type Backend, queueSchema, resultSchema } from "./api.js";
import { requestSchema, TxdError } from "./model.js";

/** Per-request/connection MCP facade over the daemon or a forwarding client. */
export const createToolServer = (backend: Backend): McpServer => {
  const server = new McpServer({ name: "git-txd", version: "0.1.0" });
  server.registerTool(
    "git_commit_and_push",
    {
      description:
        "Write local Git history and the configured remote branch using one durable FIFO worker. Freeze requested files until status settles. A lost response does not cancel or roll back a commit; retry the same ID or inspect status.",
      inputSchema: requestSchema,
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) =>
      toolResult(() => backend.commitAndPush(input, context.mcpReq.signal)),
  );
  server.registerTool(
    "git_queue_info",
    {
      description:
        "Observe the shared queue and repository health. This does not reserve a queue position.",
      inputSchema: z.strictObject({}),
      outputSchema: queueSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(async () => backend.queue()),
  );
  server.registerTool(
    "git_transaction_status",
    {
      description:
        "Recover the durable outcome by request ID after a timeout or disconnect.",
      inputSchema: z.strictObject({
        request_id: requestSchema.shape.request_id,
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id }) =>
      toolResult(async () => backend.status(request_id)),
  );
  server.registerTool(
    "git_wait_transaction",
    {
      description:
        "Wait for an already accepted request without creating another transaction.",
      inputSchema: z.strictObject({
        request_id: requestSchema.shape.request_id,
        wait_timeout_seconds: requestSchema.shape.wait_timeout_seconds,
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id, wait_timeout_seconds }, context) =>
      toolResult(() =>
        backend.wait(request_id, wait_timeout_seconds, context.mcpReq.signal),
      ),
  );
  return server;
};

const toolResult = async (
  operation: () => Promise<Record<string, unknown>>,
) => {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const code = error instanceof TxdError ? error.code : "INVALID_REQUEST";
    const message =
      error instanceof TxdError
        ? error.message
        : "Request failed validation or transport communication; inspect status if it may have been accepted.";
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error_code: code, error_message: message }),
        },
      ],
    };
  }
};
