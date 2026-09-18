import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  assertRequiredStatusChecksSuccessful,
  RequiredStatusCheckError,
  verifyRequiredStatusChecks,
} from "../../../src/github/required-status-checks.js";

const HEAD_SHA = "3facb641b17b1f31e9fb1895b558548cd48dcb78";

interface ClientOptions {
  protection: unknown;
  rules?: unknown[];
  checkRuns?: unknown[];
  statuses?: unknown[];
  checkRunsError?: unknown;
  statusesError?: unknown;
}

function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: "build",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
    app: { id: 10 },
    ...overrides,
  };
}

function commitStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, context: "build", state: "success", ...overrides };
}

function makeClient(options: ClientOptions): {
  client: GitHubClient;
  paginate: ReturnType<typeof vi.fn>;
} {
  const getBranchRules = vi.fn();
  const listForRef = vi.fn();
  const listCommitStatusesForRef = vi.fn();
  const paginate = vi.fn().mockImplementation((endpoint: unknown) => {
    if (endpoint === getBranchRules) {
      return Promise.resolve(options.rules ?? []);
    }
    if (endpoint === listForRef) {
      if (options.checkRunsError !== undefined) {
        return Promise.reject(options.checkRunsError);
      }
      return Promise.resolve(options.checkRuns ?? []);
    }
    if (endpoint === listCommitStatusesForRef) {
      if (options.statusesError !== undefined) {
        return Promise.reject(options.statusesError);
      }
      return Promise.resolve(options.statuses ?? []);
    }
    throw new Error("unexpected pagination endpoint");
  });

  return {
    client: {
      rest: {
        repos: {
          getBranchProtection: vi.fn().mockResolvedValue({ data: options.protection }),
          getBranchRules,
          listCommitStatusesForRef,
        },
        checks: { listForRef },
        paginate,
      },
    } as unknown as GitHubClient,
    paginate,
  };
}

function requiredStatusRule(context: string, integrationId?: number): Record<string, unknown> {
  return {
    type: "required_status_checks",
    parameters: {
      required_status_checks: [
        { context, ...(integrationId === undefined ? {} : { integration_id: integrationId }) },
      ],
    },
  };
}

describe("assertRequiredStatusChecksSuccessful", () => {
  it.each([
    { state: "in_progress", conclusion: null, reason: "pending" },
    { state: "completed", conclusion: "failure", reason: "failure" },
    { state: "completed", conclusion: "cancelled", reason: "cancelled" },
  ])("$reason は不合格にする", ({ state, conclusion }) => {
    expect(() =>
      assertRequiredStatusChecksSuccessful(
        [{ context: "build" }],
        [
          {
            source: "check-run",
            context: "build",
            id: 1,
            state,
            conclusion,
          },
        ],
        HEAD_SHA,
      ),
    ).toThrow(RequiredStatusCheckError);
  });

  it("required check が欠落していれば不合格にする", () => {
    expect(() =>
      assertRequiredStatusChecksSuccessful([{ context: "build" }], [], HEAD_SHA),
    ).toThrow(/is missing/);
  });

  it("同一 provider/context の再実行は最大 ID の結果を採用する", () => {
    expect(() =>
      assertRequiredStatusChecksSuccessful(
        [{ context: "build", integrationId: 10 }],
        [
          {
            source: "check-run",
            context: "build",
            integrationId: 10,
            id: 1,
            state: "completed",
            conclusion: "failure",
          },
          {
            source: "check-run",
            context: "build",
            integrationId: 10,
            id: 2,
            state: "completed",
            conclusion: "success",
          },
        ],
        HEAD_SHA,
      ),
    ).not.toThrow();
  });

  it("provider が異なる required check は app ID で区別する", () => {
    expect(() =>
      assertRequiredStatusChecksSuccessful(
        [{ context: "build", integrationId: 10 }],
        [
          {
            source: "check-run",
            context: "build",
            integrationId: 11,
            id: 1,
            state: "completed",
            conclusion: "success",
          },
        ],
        HEAD_SHA,
      ),
    ).toThrow(/is missing/);
  });

  it("同一 context の check-run と commit status は両方の成功を要求する", () => {
    expect(() =>
      assertRequiredStatusChecksSuccessful(
        [{ context: "build" }],
        [
          {
            source: "check-run",
            context: "build",
            id: 1,
            state: "completed",
            conclusion: "success",
          },
          {
            source: "commit-status",
            context: "build",
            id: 2,
            state: "failure",
          },
        ],
        HEAD_SHA,
      ),
    ).toThrow(/is not successful/);
  });

  it("required ではない check の失敗は妨げない", () => {
    expect(() =>
      assertRequiredStatusChecksSuccessful(
        [{ context: "build" }],
        [
          {
            source: "check-run",
            context: "build",
            id: 1,
            state: "completed",
            conclusion: "success",
          },
          {
            source: "check-run",
            context: "lint",
            id: 2,
            state: "completed",
            conclusion: "failure",
          },
        ],
        HEAD_SHA,
      ),
    ).not.toThrow();
  });
});

describe("verifyRequiredStatusChecks", () => {
  it("branch protection と ruleset の required check を同一 SHA で検証する", async () => {
    const { client, paginate } = makeClient({
      protection: {
        required_status_checks: {
          contexts: ["legacy-build"],
          checks: [{ context: "build", app_id: 10 }],
        },
      },
      rules: [requiredStatusRule("ruleset-build")],
      checkRuns: [checkRun({ name: "build" }), checkRun({ id: 2, name: "ruleset-build" })],
      statuses: [commitStatus({ context: "legacy-build" })],
    });

    const result = await verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA);

    expect(result).toEqual({ requiredCheckCount: 3 });
    expect(paginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: "o", repo: "r", per_page: 100 }),
    );
    expect(paginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ref: HEAD_SHA, per_page: 100 }),
    );
  });

  it("required check がなければ任意 check の取得結果に依存せず成功する", async () => {
    const { client, paginate } = makeClient({
      protection: { required_status_checks: null },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "pull_request", parameters: { required_approving_review_count: 0 } },
      ],
      checkRuns: [checkRun({ conclusion: "failure" })],
      statuses: [commitStatus({ state: "failure" })],
    });

    await expect(verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA)).resolves.toEqual({
      requiredCheckCount: 0,
    });
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("check-run の head_sha が対象 SHA と異なる場合は拒否する", async () => {
    const { client } = makeClient({
      protection: {
        required_status_checks: { contexts: ["build"] },
      },
      checkRuns: [checkRun({ head_sha: "0000000000000000000000000000000000000000" })],
    });

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({ reason: "sha_mismatch" });
  });

  it("classic branch protection の app_id -1 は任意の App として扱う", async () => {
    const { client } = makeClient({
      protection: {
        required_status_checks: {
          checks: [{ context: "build", app_id: -1 }],
        },
      },
      checkRuns: [checkRun({ app: { id: 999 } })],
    });

    await expect(verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA)).resolves.toEqual({
      requiredCheckCount: 1,
    });
  });

  it("branch protection の 404 は required check なしとして扱う", async () => {
    const { client } = makeClient({ protection: null });
    vi.mocked(client.rest.repos.getBranchProtection).mockRejectedValue(
      Object.assign(new Error("Branch not protected"), {
        response: { data: { status: "404" } },
      }),
    );

    await expect(verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA)).resolves.toEqual({
      requiredCheckCount: 0,
    });
  });

  it("branch protection の 403 は必要権限を明示して fail-closed にする", async () => {
    const { client } = makeClient({ protection: null });
    vi.mocked(client.rest.repos.getBranchProtection).mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
        response: {
          status: 403,
          data: { code: "integration_forbidden", status: "403" },
        },
      }),
    );

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({
      reason: "configuration",
      message: expect.stringContaining("Administration: read"),
      diagnostics: {
        operation: "repos.getBranchProtection",
        httpStatus: 403,
        apiErrorCode: "integration_forbidden",
        requiredPermission: "Administration: read",
      },
    });
  });

  it("branch protection の 403 以外の読み取り失敗も診断して fail-closed にする", async () => {
    const { client } = makeClient({ protection: null });
    vi.mocked(client.rest.repos.getBranchProtection).mockRejectedValue(
      Object.assign(new Error("GitHub unavailable"), {
        response: { status: 500, data: { message: "GitHub unavailable" } },
      }),
    );

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({
      reason: "configuration",
      message: expect.stringContaining("failed to read branch protection"),
      diagnostics: {
        operation: "repos.getBranchProtection",
        httpStatus: 500,
        requiredPermission: "Administration: read",
      },
    });
  });

  it("error code のない branch protection 403 は HTTP status だけを診断する", async () => {
    const { client } = makeClient({ protection: null });
    vi.mocked(client.rest.repos.getBranchProtection).mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
        response: {
          status: 403,
          data: { message: "Resource not accessible by integration", status: "403" },
        },
      }),
    );

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({
      reason: "configuration",
      diagnostics: {
        operation: "repos.getBranchProtection",
        httpStatus: 403,
        requiredPermission: "Administration: read",
      },
    });
    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.not.toMatchObject({ diagnostics: { apiErrorCode: expect.anything() } });
  });

  it("ruleset の required workflow は未対応として fail-closed にする", async () => {
    const { client } = makeClient({
      protection: { required_status_checks: null },
      rules: [{ type: "workflows", parameters: { workflows: [] } }],
    });

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({ reason: "configuration" });
  });

  it("required status-check 設定の取得失敗は fail-closed にする", async () => {
    const { client, paginate } = makeClient({ protection: { required_status_checks: null } });
    paginate.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({ reason: "configuration" });
  });

  it("check-run の取得失敗には Checks 権限と API 診断を含める", async () => {
    const { client } = makeClient({
      protection: { required_status_checks: { contexts: ["build"] } },
      checkRunsError: Object.assign(new Error("check-runs forbidden"), {
        status: 403,
        code: "forbidden",
      }),
    });

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({
      reason: "configuration",
      diagnostics: {
        operation: "checks.listForRef",
        httpStatus: 403,
        apiErrorCode: "forbidden",
        requiredPermission: "Checks: read",
      },
    });
  });

  it("commit status の取得失敗には Commit statuses 権限と API 診断を含める", async () => {
    const { client } = makeClient({
      protection: { required_status_checks: { contexts: ["build"] } },
      statusesError: Object.assign(new Error("statuses forbidden"), {
        response: { status: 403, data: { code: "forbidden" } },
      }),
    });

    await expect(
      verifyRequiredStatusChecks(client, "o", "r", "main", HEAD_SHA),
    ).rejects.toMatchObject({
      reason: "configuration",
      diagnostics: {
        operation: "repos.listCommitStatusesForRef",
        httpStatus: 403,
        apiErrorCode: "forbidden",
        requiredPermission: "Commit statuses: read",
      },
    });
  });
});
