import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GitHubClient } from "../../github/client.js";
import { getPR } from "../../github/pull-requests.js";
import { createIssueComment } from "../../github/rest.js";
import { createReviewStatusStore } from "../../queue/review-status.js";
import { createMcpServer, reviewStatusUri } from "../server.js";
import { startMcpHttpServer } from "../transports.js";
import {
  createReviewStopGuard,
  type PostReviewStopInput,
  postReviewStopTool,
} from "./post-review-stop.js";

vi.mock("../../github/pull-requests.js", () => ({ getPR: vi.fn() }));
vi.mock("../../github/rest.js", () => ({ createIssueComment: vi.fn() }));

const pr = { owner: "org", repo: "repo", prNumber: 1 };
const head = "a".repeat(40);
const moved = "b".repeat(40);
function remote() {
  return {
    number: 1,
    title: "t",
    body: null,
    state: "open",
    draft: false,
    author: { login: "alice", type: "User" },
    head: { sha: head, ref: "topic", repo: { fullName: "org/repo", fork: false } },
    base: { sha: moved, ref: "main" },
    htmlUrl: "https://github.com/org/repo/pull/1",
  };
}
function setup() {
  const reviewStatus = createReviewStatusStore();
  reviewStatus.markPending(pr, head);
  const paginate = vi.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
  const client = {
    rest: { paginate, issues: { listComments: vi.fn() } },
  } as unknown as GitHubClient;
  const deps = {
    reviewStatus,
    reviewStopGuard: createReviewStopGuard(),
    getClient: vi.fn(async () => client),
    getWriteContext: vi.fn(async () => ({
      client,
      allowedRepos: ["org/repo"],
      appId: "123",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    })),
    allowedRepos: ["org/repo"],
    allowedAuthors: ["alice"],
    trustedCommentAuthors: [],
    resolveInstallationId: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const input: PostReviewStopInput = {
    ...pr,
    delivery: "queued",
    attemptId: reviewStatus.get(pr)?.attemptId ?? undefined,
    notificationId: randomUUID(),
    reviewedHeadSha: head,
    currentHeadSha: head,
    code: "LOCAL_ENVIRONMENT_DIFFERENCE",
    facts: "生成後に改行の差異",
    unverified: "実装の正しさ",
    resumeConditions: "生成入力を確認し別runで検証",
  };
  return { deps, input, paginate };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPR).mockResolvedValue(remote());
  vi.mocked(createIssueComment).mockResolvedValue(45);
});

describe("post_review_stop", () => {
  test.each(["before-listen", "after-listen"])(
    "HTTPで%sの停止を正常完了と区別して配送する",
    async (phase) => {
      const { deps, input } = setup();
      const srv = await startMcpHttpServer(
        () => createMcpServer(deps, { name: "test", version: "1" }),
        { host: "127.0.0.1", port: 0 },
      );
      const off = deps.reviewStatus.onUpdated((status) =>
        srv.notify.resourceUpdated(reviewStatusUri(status)),
      );
      const client = new Client(
        { name: "test", version: "1" },
        { versionNegotiation: { mode: "auto" } },
      );
      let subscription: Awaited<ReturnType<Client["listen"]>> | undefined;
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)),
        );
        const notifications: string[] = [];
        client.setNotificationHandler("notifications/resources/updated", (n) => {
          notifications.push(n.params.uri);
        });
        const uri = reviewStatusUri(pr);
        if (phase === "after-listen")
          subscription = await client.listen({ resourceSubscriptions: [uri] });
        const result = await client.callTool({ name: "post_review_stop", arguments: input });
        expect(result.isError).not.toBe(true);
        if (phase === "before-listen")
          subscription = await client.listen({ resourceSubscriptions: [uri] });
        expect(subscription?.honoredFilter.resourceSubscriptions).toContain(uri);
        if (phase === "after-listen")
          await vi.waitFor(() => {
            expect(notifications).toContain(uri);
          });
        const response = await client.readResource({ uri });
        const state = JSON.parse((response.contents[0] as { text: string }).text);
        expect(state).toMatchObject({
          status: "stopped",
          attemptId: input.attemptId,
          headSha: head,
          summaryCommentId: null,
          stop: { commentId: 45 },
        });
        expect(["reviewed", "approved"]).not.toContain(state.status);
      } finally {
        await subscription?.close();
        await client.close();
        off();
        await srv.close();
      }
    },
  );

  test("結果不明ガードの上限でも再送を許可しない", () => {
    const guard = createReviewStopGuard();
    for (let i = 0; i < 100; i++) guard.uncertain(String(i));
    expect(() => guard.acquire("pr", "new")).toThrow("STOP_NOTIFICATION_UNCERTAIN");
  });

  test.each(["auth", "app-id", "write-policy"])("%s検証失敗時に投稿しない", async (condition) => {
    const { deps, input } = setup();
    const ctx = await deps.getWriteContext();
    deps.getWriteContext.mockClear();
    if (condition === "auth") deps.getWriteContext.mockRejectedValueOnce(new Error("auth failed"));
    else
      deps.getWriteContext.mockResolvedValueOnce({
        ...ctx,
        appId: condition === "app-id" ? "IvClientId" : ctx.appId,
        allowedRepos: condition === "write-policy" ? [] : ctx.allowedRepos,
      });
    await expect(postReviewStopTool(deps, input)).rejects.toThrow();
    expect(createIssueComment).not.toHaveBeenCalled();
  });

  test("直接CLIの再起動後もAppコメントから重複を検出する", async () => {
    const { deps, input, paginate } = setup();
    const direct = { ...input, delivery: "comment-only" as const, attemptId: undefined };
    await postReviewStopTool(deps, direct);
    const body = vi.mocked(createIssueComment).mock.calls[0][4];
    deps.reviewStopGuard = createReviewStopGuard();
    deps.reviewStatus = createReviewStatusStore();
    paginate.mockResolvedValue([
      { id: 45, body, user: { type: "Bot" }, performed_via_github_app: { id: 123 } },
    ]);
    expect(await postReviewStopTool(deps, direct)).toMatchObject({
      notification: "existing",
      statusUpdated: false,
    });
    expect(createIssueComment).toHaveBeenCalledOnce();
  });
  test.each([
    "LOCAL_ENVIRONMENT_DIFFERENCE",
    "LOCAL_CONTENT_CHANGED",
    "VERIFICATION_INTERRUPTED",
    "STALE_REVIEW",
  ] as const)("%sはstoppedを通知しreviewedにしない", async (code) => {
    const { deps, input } = setup();
    const listener = vi.fn();
    deps.reviewStatus.onUpdated(listener);
    const result = await postReviewStopTool(deps, { ...input, code });
    expect(result).toMatchObject({ commentId: 45, statusUpdated: true, notification: "posted" });
    expect(deps.reviewStatus.get(pr)).toMatchObject({
      status: "stopped",
      headSha: head,
      summaryCommentId: null,
      stop: { commentId: 45, code },
    });
    expect(listener).toHaveBeenCalledOnce();
    const body = vi.mocked(createIssueComment).mock.calls[0][4];
    expect(body).toContain("レビュー中断");
    expect(body).toContain(input.resumeConditions);
    expect(body).not.toMatch(/Review Verdict|READY_TO_MERGE|APPROVED/);
  });
  test("HEAD移動は旧対象と確認時HEADを区別する", async () => {
    const { deps, input } = setup();
    vi.mocked(getPR).mockResolvedValue({ ...remote(), head: { ...remote().head, sha: moved } });
    await postReviewStopTool(deps, { ...input, currentHeadSha: moved, code: "STALE_REVIEW" });
    expect(deps.reviewStatus.get(pr)).toMatchObject({
      headSha: head,
      stop: { currentHeadSha: moved },
    });
  });
  test("comment-onlyは既存pendingを変更しない", async () => {
    const { deps, input } = setup();
    const before = deps.reviewStatus.get(pr);
    expect(
      await postReviewStopTool(deps, { ...input, delivery: "comment-only", attemptId: undefined }),
    ).toMatchObject({ statusUpdated: false, attemptId: null });
    expect(deps.reviewStatus.get(pr)).toBe(before);
  });
  test.each([
    { name: "unknown code", patch: { code: "BLOCKED_PR_ORIGIN" } },
    { name: "missing attempt", patch: { attemptId: undefined } },
    { name: "comment-only binding", patch: { delivery: "comment-only" } },
    { name: "invalid SHA", patch: { reviewedHeadSha: "main" } },
    { name: "moved SHA without stale", patch: { currentHeadSha: moved } },
    { name: "completion marker", patch: { facts: "Review Verdict: APPROVED" } },
  ])("$nameは認証前に拒否", async ({ patch }) => {
    const { deps, input } = setup();
    await expect(
      postReviewStopTool(deps, { ...input, ...patch } as PostReviewStopInput),
    ).rejects.toThrow();
    expect(deps.getClient).not.toHaveBeenCalled();
    expect(deps.getWriteContext).not.toHaveBeenCalled();
  });
  test.each(["repository", "origin", "fork", "closed", "identity", "head", "read"])(
    "%s拒否時に投稿しない",
    async (condition) => {
      const { deps, input } = setup();
      const value = remote();
      if (condition === "repository") deps.allowedRepos = [];
      if (condition === "origin") deps.allowedAuthors = [];
      if (condition === "fork" && value.head.repo) value.head.repo.fork = true;
      if (condition === "closed") value.state = "closed";
      if (condition === "identity") value.htmlUrl = "https://github.com/other/repo/pull/1";
      if (condition === "head") value.head.sha = moved;
      if (condition === "read") vi.mocked(getPR).mockRejectedValueOnce(new Error("read failed"));
      else vi.mocked(getPR).mockResolvedValue(value);
      await expect(postReviewStopTool(deps, input)).rejects.toThrow();
      expect(createIssueComment).not.toHaveBeenCalled();
      expect(deps.reviewStatus.get(pr)?.status).toBe("pending");
    },
  );
  test.each(["enqueue", "restart", "completed", "head"])(
    "古いattempt: %sを上書きしない",
    async (condition) => {
      const { deps, input } = setup();
      if (condition === "enqueue") deps.reviewStatus.markPending(pr, head);
      if (condition === "restart") {
        deps.reviewStatus = createReviewStatusStore();
        deps.reviewStatus.markPending(pr, head);
      }
      if (condition === "completed")
        deps.reviewStatus.markReviewed(pr, {
          summaryCommentId: 1,
          round: deps.reviewStatus.currentRound(pr),
        });
      if (condition === "head") {
        input.reviewedHeadSha = moved;
        input.code = "STALE_REVIEW";
      }
      await expect(postReviewStopTool(deps, input)).rejects.toThrow("STOP_ATTEMPT_MISMATCH");
      expect(createIssueComment).not.toHaveBeenCalled();
    },
  );
  test("重複はApp identityと同一本文を照合する", async () => {
    const { deps, input, paginate } = setup();
    await postReviewStopTool(deps, input);
    const body = vi.mocked(createIssueComment).mock.calls[0][4];
    paginate.mockResolvedValue([
      { id: 45, body, user: { type: "Bot" }, performed_via_github_app: { id: 123 } },
    ]);
    const listener = vi.fn();
    deps.reviewStatus.onUpdated(listener);
    expect(await postReviewStopTool(deps, input)).toMatchObject({
      notification: "existing",
      statusUpdated: false,
    });
    expect(createIssueComment).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });
  test.each(["other-app", "user"])("%sのmarkerを信用しない", async (kind) => {
    const { deps, input, paginate } = setup();
    await postReviewStopTool(deps, { ...input, delivery: "comment-only", attemptId: undefined });
    const body = vi.mocked(createIssueComment).mock.calls[0][4];
    paginate.mockResolvedValue([
      {
        id: 45,
        body,
        user: { type: kind === "user" ? "User" : "Bot" },
        performed_via_github_app: { id: kind === "user" ? 123 : 999 },
      },
    ]);
    await postReviewStopTool(deps, { ...input, delivery: "comment-only", attemptId: undefined });
    expect(createIssueComment).toHaveBeenCalledTimes(2);
  });
  test("同一markerの本文変更は再投稿しない", async () => {
    const { deps, input, paginate } = setup();
    await postReviewStopTool(deps, input);
    const body = vi.mocked(createIssueComment).mock.calls[0][4];
    paginate.mockResolvedValue([
      {
        id: 45,
        body: `${body}\n編集`,
        user: { type: "Bot" },
        performed_via_github_app: { id: 123 },
      },
    ]);
    await expect(postReviewStopTool(deps, input)).rejects.toThrow("STOP_NOTIFICATION_CONFLICT");
    expect(createIssueComment).toHaveBeenCalledOnce();
  });
  test("コメント検索失敗時は投稿しない", async () => {
    const { deps, input, paginate } = setup();
    paginate.mockRejectedValue(new Error("pagination failed"));
    await expect(postReviewStopTool(deps, input)).rejects.toThrow("pagination failed");
    expect(createIssueComment).not.toHaveBeenCalled();
  });
  test("通知前の再確認でHEADが動けば投稿しない", async () => {
    const { deps, input } = setup();
    vi.mocked(getPR)
      .mockResolvedValueOnce(remote())
      .mockResolvedValueOnce({ ...remote(), head: { ...remote().head, sha: moved } });
    await expect(postReviewStopTool(deps, input)).rejects.toThrow("STOP_HEAD_MISMATCH");
    expect(createIssueComment).not.toHaveBeenCalled();
  });
  test("投稿前に次enqueueが入れば投稿しない", async () => {
    const { deps, input, paginate } = setup();
    paginate.mockImplementationOnce(async () => {
      deps.reviewStatus.markPending(pr, head);
      return [];
    });
    await expect(postReviewStopTool(deps, input)).rejects.toThrow("STOP_ATTEMPT_MISMATCH");
    expect(createIssueComment).not.toHaveBeenCalled();
  });
  test("投稿中enqueueは新pendingを維持し部分成功を返す", async () => {
    const { deps, input } = setup();
    vi.mocked(createIssueComment).mockImplementationOnce(async () => {
      deps.reviewStatus.markPending(pr, head);
      return 45;
    });
    expect(await postReviewStopTool(deps, input)).toMatchObject({
      commentId: 45,
      statusUpdated: false,
    });
    expect(deps.reviewStatus.get(pr)?.status).toBe("pending");
  });
  test("同時通知は1件だけ投稿する", async () => {
    const { deps, input } = setup();
    const [first, second] = await Promise.allSettled([
      postReviewStopTool(deps, input),
      postReviewStopTool(deps, { ...input, notificationId: randomUUID() }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(createIssueComment).toHaveBeenCalledOnce();
  });
  test("結果不明は再送せずpendingを維持する", async () => {
    const { deps, input } = setup();
    vi.mocked(createIssueComment).mockRejectedValueOnce(new Error("transport lost"));
    await expect(postReviewStopTool(deps, input)).rejects.toThrow("STOP_NOTIFICATION_UNCERTAIN");
    await expect(postReviewStopTool(deps, input)).rejects.toThrow("STOP_NOTIFICATION_UNCERTAIN");
    expect(createIssueComment).toHaveBeenCalledOnce();
    expect(deps.reviewStatus.get(pr)?.status).toBe("pending");
    deps.reviewStatus.markPending(pr, head);
    await postReviewStopTool(deps, {
      ...input,
      attemptId: deps.reviewStatus.get(pr)?.attemptId ?? undefined,
    });
    expect(createIssueComment).toHaveBeenCalledTimes(2);
  });
});
