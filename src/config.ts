import * as z from "zod/v4";

/** Startup-only policy. Unsafe Git behaviors are intentionally not configurable. */
export const configSchema = z
  .strictObject({
    repo: z.string().min(1),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .default("origin"),
    branch: z.string().min(1),
    stateDir: z.string().optional(),
    acceptAlignedHead: z.boolean().default(false),
    port: z.number().int().min(0).max(65535).default(8787),
    logFile: z.string().min(1).optional(),
    ledgerRetentionDays: z.number().int().min(1).max(36500).default(30),
    ledgerArchiveBatchSize: z.number().int().min(1).max(1000).default(100),
    committer: z
      .strictObject({
        name: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^\r\n<>\0]+$/),
        email: z.string().email(),
      })
      .default({
        name: "Git Transaction Coordinator",
        email: "git-txd@localhost.invalid",
      }),
    allowedAuthors: z
      .array(z.strictObject({ name: z.string(), email: z.string() }))
      .default([]),
    maxPending: z.number().int().positive().max(10000).default(100),
    maxPendingPerAgent: z.number().int().positive().max(10000).default(100),
    slotMs: z.number().int().positive().default(45000),
    minQueueMs: z.number().int().positive().default(45000),
    maxQueueMs: z.number().int().positive().default(600000),
    gitTimeoutMs: z.number().int().positive().default(120000),
    pushTimeoutMs: z.number().int().positive().default(90000),
    reconciliationTimeoutMs: z.number().int().positive().default(60000),
    pushRetries: z.number().int().min(0).max(10).default(2),
  })
  .refine(
    (value) => value.minQueueMs <= value.maxQueueMs,
    "Invalid queue bounds",
  );

/** Fully resolved daemon configuration. */
export type Config = z.infer<typeof configSchema>;
/** Queue deadline is frozen at durable acceptance. */
export const queueAllowance = (ahead: number, config: Config): number =>
  Math.min(
    config.maxQueueMs,
    Math.max(config.minQueueMs, (ahead + 1) * config.slotMs),
  );
