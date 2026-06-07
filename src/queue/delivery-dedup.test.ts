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

  test("periodic GC physically deletes expired entries without relying on isSeen lazy cleanup", () => {
    vi.useFakeTimers();
    const ttlMs = 1000;
    const gcIntervalMs = 500;
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    const dedup = createDeliveryDedup(ttlMs, gcIntervalMs);

    dedup.markSeen("a");
    dedup.markSeen("b");
    // markSeen 後のカウンタをリセット（Map 内部実装による delete 呼び出しを除外）
    deleteSpy.mockClear();

    // TTL + GC インターバル経過後に GC が期限切れエントリを直接 delete する
    vi.advanceTimersByTime(ttlMs + gcIntervalMs);

    // isSeen()（lazy cleanup）を呼ばずに GC が Map.delete を呼んだことを確認
    expect(deleteSpy).toHaveBeenCalledWith("a");
    expect(deleteSpy).toHaveBeenCalledWith("b");

    deleteSpy.mockRestore();
    dedup.dispose();
    vi.useRealTimers();
  });
});
