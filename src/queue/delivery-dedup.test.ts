import { describe, expect, test, vi } from "vitest";
import { createDeliveryDedup } from "./delivery-dedup.js";

describe("createDeliveryDedup", () => {
  test("unseen delivery returns false", () => {
    const dedup = createDeliveryDedup();
    expect(dedup.isSeen("abc")).toBe(false);
    dedup.dispose();
  });

  test("seen delivery returns true", () => {
    const dedup = createDeliveryDedup();
    dedup.markSeen("abc");
    expect(dedup.isSeen("abc")).toBe(true);
    dedup.dispose();
  });

  test("different delivery IDs are independent", () => {
    const dedup = createDeliveryDedup();
    dedup.markSeen("a");
    expect(dedup.isSeen("b")).toBe(false);
    dedup.dispose();
  });

  test("expired entry is treated as unseen", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const dedup = createDeliveryDedup(ttlMs);
    dedup.markSeen("abc");

    vi.advanceTimersByTime(ttlMs + 1);
    expect(dedup.isSeen("abc")).toBe(false);

    dedup.dispose();
    vi.useRealTimers();
  });

  test("entry within TTL is still seen", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const dedup = createDeliveryDedup(ttlMs);
    dedup.markSeen("abc");

    vi.advanceTimersByTime(ttlMs - 1);
    expect(dedup.isSeen("abc")).toBe(true);

    dedup.dispose();
    vi.useRealTimers();
  });

  test("periodic GC removes expired entries from Map", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const gcIntervalMs = 500;
    const dedup = createDeliveryDedup(ttlMs, gcIntervalMs);

    dedup.markSeen("a");
    dedup.markSeen("b");

    // TTL 経過後に GC インターバルが発火して期限切れエントリが削除される
    vi.advanceTimersByTime(ttlMs + gcIntervalMs);

    // GC 後は期限切れエントリが Map から消え、isSeen は false を返す
    expect(dedup.isSeen("a")).toBe(false);
    expect(dedup.isSeen("b")).toBe(false);

    dedup.dispose();
    vi.useRealTimers();
  });
});
