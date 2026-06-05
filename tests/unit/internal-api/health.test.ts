import { describe, expect, it } from "vitest";
import { getHealth } from "../../../src/internal-api/health.js";

describe("getHealth", () => {
  it("{ status: 'ok' } を返す", () => {
    expect(getHealth()).toEqual({ status: "ok" });
  });
});
