import { describe, expect, test } from "vitest";
import { createSubscriptionSession } from "./listen.js";

describe("createSubscriptionSession", () => {
  test("初期状態では subscribe されていない", () => {
    const session = createSubscriptionSession();
    expect(session.isSubscribed("queue://review/queue")).toBe(false);
  });

  test("subscribe 後は isSubscribed が true", () => {
    const session = createSubscriptionSession();
    session.subscribe("queue://review/queue");
    expect(session.isSubscribed("queue://review/queue")).toBe(true);
  });

  test("unsubscribe 後は isSubscribed が false", () => {
    const session = createSubscriptionSession();
    session.subscribe("queue://review/queue");
    session.unsubscribe("queue://review/queue");
    expect(session.isSubscribed("queue://review/queue")).toBe(false);
  });

  test("subscribe → unsubscribe → re-subscribe で isSubscribed が true に戻る", () => {
    const session = createSubscriptionSession();
    session.subscribe("queue://review/queue");
    session.unsubscribe("queue://review/queue");
    session.subscribe("queue://review/queue");
    expect(session.isSubscribed("queue://review/queue")).toBe(true);
  });

  test("dispose 後は isSubscribed が false", () => {
    const session = createSubscriptionSession();
    session.subscribe("queue://review/queue");
    session.dispose();
    expect(session.isSubscribed("queue://review/queue")).toBe(false);
  });

  test("複数の URI を独立して管理できる", () => {
    const session = createSubscriptionSession();
    session.subscribe("uri://a");
    expect(session.isSubscribed("uri://a")).toBe(true);
    expect(session.isSubscribed("uri://b")).toBe(false);
  });
});
