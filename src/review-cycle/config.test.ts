import { describe, expect, test } from "vitest";
import { loadInternalSurfaceConfig } from "./config.js";

const ACL = JSON.stringify({
  services: { "svc-raven": { actions: ["accept"], repos: ["org/*"] } },
});
const SECRET = "proxy-secret-0123456789";
const full = {
  THREAD_OWL_LEDGER_PATH: "/data/ledger.sqlite",
  THREAD_OWL_INTERNAL_PROXY_SECRET: SECRET,
  THREAD_OWL_SERVICE_ACL: ACL,
};

describe("loadInternalSurfaceConfig", () => {
  test("何も設定しなければ内部面は無効", () => {
    expect(loadInternalSurfaceConfig({}, "/mcp")).toBeUndefined();
    expect(loadInternalSurfaceConfig({ THREAD_OWL_LEDGER_PATH: "  " }, "/mcp")).toBeUndefined();
  });

  test("3 つが揃えば有効で、パスの既定は /internal/mcp", () => {
    const config = loadInternalSurfaceConfig(full, "/mcp");
    expect(config).toMatchObject({
      ledgerPath: "/data/ledger.sqlite",
      proxySecret: SECRET,
      path: "/internal/mcp",
    });
    expect(config?.serviceAcl.allows("svc-raven", "accept", { owner: "org", repo: "x" })).toBe(
      true,
    );
  });

  test("パスを指定でき、末尾のスラッシュは正規化する", () => {
    expect(
      loadInternalSurfaceConfig({ ...full, THREAD_OWL_INTERNAL_MCP_PATH: "/svc/mcp/" }, "/mcp")
        ?.path,
    ).toBe("/svc/mcp");
  });

  test.each([
    ["台帳のパスだけ無い", { ...full, THREAD_OWL_LEDGER_PATH: undefined }],
    ["secret だけ無い", { ...full, THREAD_OWL_INTERNAL_PROXY_SECRET: undefined }],
    ["ACL だけ無い", { ...full, THREAD_OWL_SERVICE_ACL: undefined }],
  ])("一部だけの設定は起動を止める（%s）", (_name, env) => {
    expect(() => loadInternalSurfaceConfig(env, "/mcp")).toThrow(/must be set together/);
  });

  test.each([
    ["secret が短い", { THREAD_OWL_INTERNAL_PROXY_SECRET: "short" }, /at least 16/],
    ["パスが / で始まらない", { THREAD_OWL_INTERNAL_MCP_PATH: "internal" }, /start with '\/'/],
    ["公開の MCP パスと同じ", { THREAD_OWL_INTERNAL_MCP_PATH: "/mcp/" }, /must differ/],
    ["ACL が不正", { THREAD_OWL_SERVICE_ACL: "{}" }, /THREAD_OWL_SERVICE_ACL/],
  ])("不正な設定は起動を止める（%s）", (_name, override, message) => {
    expect(() => loadInternalSurfaceConfig({ ...full, ...override }, "/mcp")).toThrow(message);
  });
});

describe("結果の配送の設定", () => {
  const delivery = {
    THREAD_OWL_RAVEN_INTERNAL_URL: "https://gateway.example/mcp/raven-internal",
    THREAD_OWL_RAVEN_INTERNAL_TOKEN: "service-credential-0123456789",
  };

  test("未設定なら配送しない", () => {
    expect(loadInternalSurfaceConfig(full, "/mcp")?.delivery).toBeUndefined();
  });

  test("URL と資格情報が揃えば有効で、間隔の既定は 5 秒", () => {
    expect(loadInternalSurfaceConfig({ ...full, ...delivery }, "/mcp")?.delivery).toEqual({
      endpoint: "https://gateway.example/mcp/raven-internal",
      token: "service-credential-0123456789",
      intervalMs: 5000,
    });
  });

  test("間隔を指定できる", () => {
    expect(
      loadInternalSurfaceConfig(
        { ...full, ...delivery, THREAD_OWL_DELIVERY_INTERVAL_SEC: "30" },
        "/mcp",
      )?.delivery?.intervalMs,
    ).toBe(30000);
  });

  test.each([
    [
      "URL だけ",
      { THREAD_OWL_RAVEN_INTERNAL_URL: delivery.THREAD_OWL_RAVEN_INTERNAL_URL },
      /set together/,
    ],
    [
      "資格情報だけ",
      { THREAD_OWL_RAVEN_INTERNAL_TOKEN: delivery.THREAD_OWL_RAVEN_INTERNAL_TOKEN },
      /set together/,
    ],
    [
      "平文の外部 http",
      { ...delivery, THREAD_OWL_RAVEN_INTERNAL_URL: "http://gateway.example/mcp" },
      /https/,
    ],
    ["間隔が範囲外 (0)", { ...delivery, THREAD_OWL_DELIVERY_INTERVAL_SEC: "0" }, /1\.\.3600/],
    ["間隔が範囲外 (3601)", { ...delivery, THREAD_OWL_DELIVERY_INTERVAL_SEC: "3601" }, /1\.\.3600/],
    ["間隔が整数でない", { ...delivery, THREAD_OWL_DELIVERY_INTERVAL_SEC: "1.5" }, /1\.\.3600/],
    ["間隔が数値でない", { ...delivery, THREAD_OWL_DELIVERY_INTERVAL_SEC: "soon" }, /1\.\.3600/],
  ])("不正な設定は起動を止める（%s）", (_name, override, message) => {
    expect(() => loadInternalSurfaceConfig({ ...full, ...override }, "/mcp")).toThrow(message);
  });

  test("内部面の設定が無ければ、配送の設定だけでは有効にならない", () => {
    expect(loadInternalSurfaceConfig(delivery, "/mcp")).toBeUndefined();
  });
});
