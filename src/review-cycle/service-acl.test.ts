import { describe, expect, test } from "vitest";
import { parseServiceAcl } from "./service-acl.js";

const valid = {
  services: {
    "svc-raven": { actions: ["accept", "cancel"], repos: ["Scottlz0310/*", "other/repo"] },
  },
};

describe("parseServiceAcl", () => {
  test.each([
    ["JSON ではない", "{"],
    ["services が無い", "{}"],
    ["services が配列", '{"services":[]}'],
    ["サービスが 0 件", '{"services":{}}'],
    ["サービス名が不正", JSON.stringify({ services: { "bad name": valid.services["svc-raven"] } })],
    ["actions が空", JSON.stringify({ services: { s: { actions: [], repos: ["a/b"] } } })],
    ["未知の action", JSON.stringify({ services: { s: { actions: ["delete"], repos: ["a/b"] } } })],
    ["repos が空", JSON.stringify({ services: { s: { actions: ["accept"], repos: [] } } })],
    [
      "repo の書式が不正",
      JSON.stringify({ services: { s: { actions: ["accept"], repos: ["*/x"] } } }),
    ],
    [
      "大文字小文字違いの重複",
      JSON.stringify({
        services: {
          S: { actions: ["accept"], repos: ["a/b"] },
          s: { actions: ["accept"], repos: ["a/b"] },
        },
      }),
    ],
  ])("不正な設定は起動を止める（%s）", (_name, raw) => {
    expect(() => parseServiceAcl(raw)).toThrow(/THREAD_OWL_SERVICE_ACL/);
  });

  test.each([
    ["許可された操作と repo", "svc-raven", "accept", { owner: "scottlz0310", repo: "x" }, true],
    ["owner/repo の完全一致", "svc-raven", "cancel", { owner: "other", repo: "repo" }, true],
    [
      "主体の大文字小文字は区別しない",
      "SVC-RAVEN",
      "accept",
      { owner: "scottlz0310", repo: "x" },
      true,
    ],
    ["repo を問わない操作の認可（repo 不明）", "svc-raven", "cancel", undefined, true],
    ["許可されていない操作", "svc-raven", "get_result", { owner: "scottlz0310", repo: "x" }, false],
    ["許可されていない repo", "svc-raven", "accept", { owner: "other", repo: "else" }, false],
    ["未登録の主体", "svc-x", "accept", undefined, false],
  ] as const)("%s", (_name, subject, action, repo, expected) => {
    expect(parseServiceAcl(JSON.stringify(valid)).allows(subject, action, repo)).toBe(expected);
  });
});
