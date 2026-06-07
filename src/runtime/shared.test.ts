import { describe, expect, test } from "vitest";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../config/logging.js";
import { createSharedRuntime } from "./shared.js";

const mockConfig: AppConfig = {
  appSlug: "test",
  github: { appId: "123", privateKey: "test-key" },
  policy: { allowedRepos: [] },
  server: { port: 3000, host: "127.0.0.1", mcpHttpPath: "/mcp" },
  logging: { level: "info" },
};

const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("createSharedRuntime", () => {
  test("returns runtime with all expected fields", () => {
    const runtime = createSharedRuntime(mockConfig, mockLogger);

    expect(runtime.config).toBe(mockConfig);
    expect(runtime.logger).toBe(mockLogger);
    expect(runtime.reviewQueue).toBeDefined();
    expect(runtime.deliveryDedup).toBeDefined();
    expect(runtime.issueTokenDeps).toBeDefined();
    expect(runtime.issueTokenDeps.config).toBe(mockConfig);
    expect(runtime.issueTokenDeps.logger).toBe(mockLogger);
  });

  test("each call creates independent queues", () => {
    const r1 = createSharedRuntime(mockConfig, mockLogger);
    const r2 = createSharedRuntime(mockConfig, mockLogger);

    expect(r1.reviewQueue).not.toBe(r2.reviewQueue);
    expect(r1.deliveryDedup).not.toBe(r2.deliveryDedup);
  });
});
