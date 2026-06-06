import { describe, expect, it } from "vitest";
import {
  getDefaultPolicy,
  getReadOnlyPolicy,
  resolveRepositoryPolicy,
} from "../../../src/policy/repository-policy.js";

describe("resolveRepositoryPolicy", () => {
  const allowlist = ["octo-org/octo-repo"];

  it("allowlist 内のリポジトリは write 許可（default policy）", () => {
    const policy = resolveRepositoryPolicy(allowlist, "octo-org", "octo-repo");
    expect(policy).toEqual(getDefaultPolicy("octo-org", "octo-repo"));
    expect(policy.allowInlineComments).toBe(true);
    expect(policy.allowSummaryComments).toBe(true);
    expect(policy.allowResolve).toBe(true);
  });

  it("allowlist 外のリポジトリは read-only", () => {
    const policy = resolveRepositoryPolicy(allowlist, "evil", "repo");
    expect(policy).toEqual(getReadOnlyPolicy("evil", "repo"));
    expect(policy.allowInlineComments).toBe(false);
    expect(policy.allowSummaryComments).toBe(false);
    expect(policy.allowResolve).toBe(false);
  });

  it("allowlist が空なら read-only（fail-closed）", () => {
    const policy = resolveRepositoryPolicy([], "octo-org", "octo-repo");
    expect(policy.allowInlineComments).toBe(false);
  });

  it("大文字小文字を区別せず allowlist と照合する", () => {
    const policy = resolveRepositoryPolicy(allowlist, "Octo-Org", "Octo-Repo");
    expect(policy.allowInlineComments).toBe(true);
  });
});
