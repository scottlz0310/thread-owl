import { describe, expect, it, vi } from "vitest";
import { createLogger, isLevelEnabled } from "../../../src/config/logging.js";

describe("isLevelEnabled", () => {
  it.each([
    ["trace", "trace", true],
    ["trace", "error", true],
    ["info", "info", true],
    ["info", "warn", true],
    ["info", "debug", false],
    ["error", "warn", false],
    ["error", "error", true],
  ] as const)("configured=%s target=%s → %s", (configured, target, expected) => {
    expect(isLevelEnabled(configured, target)).toBe(expected);
  });
});

describe("createLogger", () => {
  it("設定レベル以上のメッセージを出力する", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("warn");

    logger.error("error msg");
    logger.warn("warn msg");
    logger.info("info msg");
    logger.debug("debug msg");

    expect(spy).toHaveBeenCalledTimes(2);
    const calls = spy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(calls[0].level).toBe("error");
    expect(calls[1].level).toBe("warn");

    spy.mockRestore();
  });

  it("出力に msg・time・level フィールドが含まれる", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("info");

    logger.info("hello", { key: "value" });

    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.msg).toBe("hello");
    expect(entry.level).toBe("info");
    expect(entry.time).toBeDefined();
    expect(entry.key).toBe("value");

    spy.mockRestore();
  });

  it("data の level/msg/time フィールドが logger の予約フィールドを上書きできない", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("info");

    logger.info("real msg", { level: "error", msg: "injected", time: "1970-01-01T00:00:00.000Z" });

    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("real msg");
    expect(entry.time).not.toBe("1970-01-01T00:00:00.000Z");

    spy.mockRestore();
  });

  it("write 引数で出力先を差し替えられる（MCP stderr 用）", () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));

    logger.info("hello");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe("hello");
  });
});
