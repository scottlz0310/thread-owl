import { describe, expect, test, vi } from "vitest";
import { createDeliveryDedup } from "./delivery-dedup.js";

describe("createDeliveryDedup", () => {
  test("unseen delivery returns false", () => {
    const dedup = createDeliveryDedup();
    expect(dedup.isSeen("abc")).toBe(false);
  });

  test("seen delivery returns true", () => {
    const dedup = createDeliveryDedup();
    dedup.markSeen("abc");
    expect(dedup.isSeen("abc")).toBe(true);
  });

  test("different delivery IDs are independent", () => {
    const dedup = createDeliveryDedup();
    dedup.markSeen("a");
    expect(dedup.isSeen("b")).toBe(false);
  });

  test("expired entry is treated as unseen", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const dedup = createDeliveryDedup(ttlMs);
    dedup.markSeen("abc");

    vi.advanceTimersByTime(ttlMs + 1);
    expect(dedup.isSeen("abc")).toBe(false);

    vi.useRealTimers();
  });

  test("entry within TTL is still seen", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const dedup = createDeliveryDedup(ttlMs);
    dedup.markSeen("abc");

    vi.advanceTimersByTime(ttlMs - 1);
    expect(dedup.isSeen("abc")).toBe(true);

    vi.useRealTimers();
  });
});
