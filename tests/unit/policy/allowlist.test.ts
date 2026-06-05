import { describe, expect, it } from "vitest";
import { isAllowed } from "../../../src/policy/allowlist.js";

describe("isAllowed", () => {
  const allowlist = ["octo-org/octo-repo", "acme/widgets"];

  it.each([
    { owner: "octo-org", repo: "octo-repo", expected: true },
    { owner: "Octo-Org", repo: "Octo-Repo", expected: true }, // case-insensitive
    { owner: "acme", repo: "widgets", expected: true },
    { owner: "octo-org", repo: "other-repo", expected: false },
    { owner: "evil", repo: "repo", expected: false },
  ])("$owner/$repo → $expected", ({ owner, repo, expected }) => {
    expect(isAllowed(allowlist, owner, repo)).toBe(expected);
  });

  it("allowedRepos が空なら全拒否（fail-closed）", () => {
    expect(isAllowed([], "octo-org", "octo-repo")).toBe(false);
  });
});
