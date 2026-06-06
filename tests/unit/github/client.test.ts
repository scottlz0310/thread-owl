import { describe, expect, it } from "vitest";
import { createClient } from "../../../src/github/client.js";

describe("createClient", () => {
  it("installation token で REST(Octokit) と GraphQL クライアントを構築する", () => {
    const client = createClient("ghs_dummy_token");

    expect(client.rest.pulls).toBeDefined(); // Octokit インスタンスであること
    expect(typeof client.graphql).toBe("function");
  });
});
