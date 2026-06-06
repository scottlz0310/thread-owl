import { describe, expect, it, vi } from "vitest";
import type { IssueTokenDeps } from "../../../src/internal-api/token-source.js";

vi.mock("../../../src/internal-api/token-source.js");
vi.mock("../../../src/github/client.js");

import * as clientModule from "../../../src/github/client.js";
import * as tokenSource from "../../../src/internal-api/token-source.js";
import { buildToolDeps } from "../../../src/mcp/tool-deps.js";

const issueTokenDeps = {
  config: { policy: { allowedRepos: ["o/r"] } },
  logger: { info: vi.fn() },
} as unknown as IssueTokenDeps;

describe("buildToolDeps", () => {
  it("getClient は issueToken の token で createClient する", async () => {
    vi.mocked(tokenSource.issueToken).mockResolvedValue({ token: "ghs_x", expiresAt: "t" });
    const fakeClient = {} as never;
    vi.mocked(clientModule.createClient).mockReturnValue(fakeClient);

    const deps = buildToolDeps(issueTokenDeps);
    const client = await deps.getClient("o", "r");

    expect(tokenSource.issueToken).toHaveBeenCalledWith({ owner: "o", repo: "r" }, issueTokenDeps);
    expect(clientModule.createClient).toHaveBeenCalledWith("ghs_x");
    expect(client).toBe(fakeClient);
  });

  it("getWriteContext は client + allowedRepos + logger を返す", async () => {
    vi.mocked(tokenSource.issueToken).mockResolvedValue({ token: "ghs_x", expiresAt: "t" });
    const fakeClient = {} as never;
    vi.mocked(clientModule.createClient).mockReturnValue(fakeClient);

    const deps = buildToolDeps(issueTokenDeps);
    const ctx = await deps.getWriteContext("o", "r");

    expect(ctx.client).toBe(fakeClient);
    expect(ctx.allowedRepos).toEqual(["o/r"]);
    expect(ctx.logger).toBe(issueTokenDeps.logger);
  });
});
