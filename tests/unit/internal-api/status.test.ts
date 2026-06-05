import { describe, expect, it } from "vitest";
import { getStatus } from "../../../src/internal-api/status.js";

describe("getStatus", () => {
  it("appId / version / startedAt を返す", () => {
    const status = getStatus({
      appId: "123456",
      version: "0.1.0",
      startedAt: new Date("2026-06-05T00:00:00Z"),
    });

    expect(status).toEqual({
      appId: "123456",
      version: "0.1.0",
      startedAt: "2026-06-05T00:00:00.000Z",
    });
  });

  it("secret（token/privateKey/JWT/installation token）を含まない", () => {
    const status = getStatus({
      appId: "123456",
      version: "0.1.0",
      startedAt: new Date("2026-06-05T00:00:00Z"),
    });

    expect(Object.keys(status)).toEqual(["appId", "version", "startedAt"]);
    const serialized = JSON.stringify(status).toLowerCase();
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("privatekey");
    expect(serialized).not.toContain("jwt");
  });
});
