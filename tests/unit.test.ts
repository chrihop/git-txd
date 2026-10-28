import { describe, expect, it } from "vitest";
import { configSchema, queueAllowance } from "../src/config.js";
import {
  digestRequest,
  requestSchema,
  validatePathSyntax,
} from "../src/model.js";
import { request } from "./helpers.js";

describe("bounded request contract", () => {
  it.each([
    "../escape",
    "/absolute",
    "a/../b",
    ".git/config",
    "sub/.GIT/index",
    "*",
    "a?",
    "a[0]",
    "a\\b",
    "a//b",
    "./a",
    "C:/a",
    "a\0b",
  ])("rejects %s", (path) => {
    expect(() => validatePathSyntax([{ path, operation: "add" }])).toThrow();
  });
  it("allows literal unusual filenames and rejects duplicate paths", () => {
    expect(() =>
      validatePathSyntax([{ path: "-dash\n:name.txt", operation: "add" }]),
    ).not.toThrow();
    expect(() =>
      validatePathSyntax([...request("a").files, ...request("a").files]),
    ).toThrow();
  });
  it("protects the transaction trailer and rejects unknown commit arguments", () => {
    expect(() =>
      requestSchema.parse({
        ...request("a"),
        message: "Subject\n\nGit-Tx-Id: other",
      }),
    ).toThrow();
    expect(() =>
      requestSchema.parse({ ...request("a"), remote: "attacker" }),
    ).toThrow();
  });
  it("canonicalizes file order and excludes wait time and diagnostic metadata", () => {
    const a = {
      ...request("a"),
      files: [...request("a").files, ...request("b").files],
    };
    const b = {
      ...a,
      files: [...a.files].reverse(),
      wait_timeout_seconds: 1,
      metadata: { agent_id: "b" },
    };
    expect(digestRequest(a, "repo")).toBe(digestRequest(b, "repo"));
    expect(digestRequest(a, "repo")).not.toBe(
      digestRequest({ ...a, message: "changed" }, "repo"),
    );
  });
  it("derives capped FIFO deadlines from the accepted queue size", () => {
    const config = configSchema.parse({ repo: "/tmp/repo", branch: "main" });
    expect(queueAllowance(0, config)).toBe(45000);
    expect(queueAllowance(3, config)).toBe(180000);
    expect(queueAllowance(100, config)).toBe(600000);
  });
});
