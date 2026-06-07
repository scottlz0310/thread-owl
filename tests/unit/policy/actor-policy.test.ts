import { describe, expect, it } from "vitest";
import { type Actor, isBotActor, shouldIgnoreEvent } from "../../../src/policy/actor-policy.js";

const APP_SLUG = "thread-owl";

describe("isBotActor", () => {
  it.each([
    { actor: { login: "thread-owl[bot]", type: "Bot" }, expected: true },
    { actor: { login: "Thread-Owl[bot]", type: "Bot" }, expected: true }, // case-insensitive
    { actor: { login: "thread-owl[bot]", type: "App" }, expected: true },
    { actor: { login: "someone", type: "User" }, expected: false },
    { actor: { login: "thread-owl[bot]", type: "User" }, expected: false }, // User は常に false
    { actor: { login: "other-app[bot]", type: "Bot" }, expected: false }, // 別アプリ
  ] as { actor: Actor; expected: boolean }[])("$actor.login ($actor.type) → $expected", ({
    actor,
    expected,
  }) => {
    expect(isBotActor(actor, APP_SLUG)).toBe(expected);
  });
});

describe("shouldIgnoreEvent", () => {
  it.each([
    { senderLogin: "thread-owl[bot]", expected: true },
    { senderLogin: "Thread-Owl[bot]", expected: true },
    { senderLogin: "human-user", expected: false },
    { senderLogin: "other-app[bot]", expected: false },
  ])("$senderLogin → $expected", ({ senderLogin, expected }) => {
    expect(shouldIgnoreEvent(senderLogin, APP_SLUG)).toBe(expected);
  });
});
