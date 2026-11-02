import { createHash } from "node:crypto";
import { z } from "zod";
import { getPR } from "../../github/pull-requests.js";
import { createIssueComment } from "../../github/rest.js";
import { auditWrite } from "../../github/write-context.js";
import { assertRepoWritable } from "../../policy/allowlist.js";
import { evaluatePullRequestOrigin, pullRequestOrigin } from "../../policy/author-policy.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";

export const POST_REVIEW_STOP_TOOL_NAME = "post_review_stop";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const detail = z.string().trim().min(1).max(4096);
export const postReviewStopInputSchema = {
  owner: z.string().regex(/^[a-zA-Z0-9-]+$/),
  repo: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  prNumber: z.number().int().positive(),
  delivery: z.enum(["queued", "comment-only"]),
  attemptId: z.uuid().optional(),
  notificationId: z.uuid(),
  reviewedHeadSha: sha,
  currentHeadSha: sha,
  code: z.enum([
    "STALE_REVIEW",
    "LOCAL_CONTENT_CHANGED",
    "LOCAL_ENVIRONMENT_DIFFERENCE",
    "REPOSITORY_STATE_UNSAFE",
    "VERIFICATION_INTERRUPTED",
    "INVALID_COMMENT_POSITION",
    "VERDICT_TOOL_UNAVAILABLE",
    "VERDICT_FORMAT_INVALID",
  ]),
  facts: detail,
  unverified: detail,
  resumeConditions: detail,
};

export type PostReviewStopInput = z.infer<z.ZodObject<typeof postReviewStopInputSchema>>;

// HTTPではMCP server/depsが要求ごとに作られる。ロックと結果不明ガードはプロセス内で共有する。
export function createReviewStopGuard() {
  const active = new Set<string>();
  const uncertain = new Set<string>();
  return {
    acquire(key: string, notificationKey: string) {
      if (active.has(key))
        throw new Error("STOP_NOTIFICATION_IN_PROGRESS: read back; do not resend");
      if (uncertain.has(notificationKey) || uncertain.size >= 100) {
        throw new Error("STOP_NOTIFICATION_UNCERTAIN: read back; do not resend");
      }
      active.add(key);
    },
    release(key: string) {
      active.delete(key);
    },
    uncertain(key: string) {
      uncertain.add(key);
    },
  };
}
const processGuard = createReviewStopGuard();

interface StopDeps extends ToolDeps {
  reviewStatus?: ReviewStatusStore;
  reviewStopGuard?: ReturnType<typeof createReviewStopGuard>;
}

function quote(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export async function postReviewStopTool(deps: StopDeps, raw: PostReviewStopInput) {
  const input = z.strictObject(postReviewStopInputSchema).parse(raw);
  if ((input.delivery === "queued") !== (input.attemptId !== undefined)) {
    throw new Error("STOP_INPUT_INVALID: queued requires attemptId; comment-only forbids it");
  }
  if (input.reviewedHeadSha !== input.currentHeadSha && input.code !== "STALE_REVIEW") {
    throw new Error("STOP_INPUT_INVALID: moved head requires STALE_REVIEW");
  }
  for (const text of [input.facts, input.unverified, input.resumeConditions]) {
    if (/Review Verdict|READY_TO_MERGE|APPROVED|verdict\s*:/i.test(text)) {
      throw new Error("STOP_INPUT_INVALID: stop details must not contain completion markers");
    }
  }
  assertRepoWritable(deps.allowedRepos, input.owner, input.repo);
  const key = `${input.owner}/${input.repo}#${input.prNumber}`.toLowerCase();
  const scope = input.attemptId ?? input.notificationId;
  const markerKey = createHash("sha256")
    .update(`${key}\n${input.delivery}\n${scope}`)
    .digest("hex");
  const marker = `<!-- thread-owl:review-stop:v1:${markerKey} -->`;
  const body = [
    "## @thread-owl レビュー中断",
    "",
    "この実行は中断しました。レビュー完了・承認・マージ可能を示すものではありません。",
    "",
    `- PR: ${key}`,
    `- 対象HEAD: \`${input.reviewedHeadSha}\``,
    `- 通知確認時HEAD: \`${input.currentHeadSha}\``,
    `- 停止コード: \`${input.code}\``,
    `- 通知識別子: \`${scope}\``,
    "",
    "### 観測事実",
    quote(input.facts),
    "",
    "### 未検証範囲",
    quote(input.unverified),
    "",
    "### 再開条件",
    quote(input.resumeConditions),
    "",
    marker,
  ].join("\n");

  function assertAttempt(allowStopped: boolean) {
    if (input.delivery === "comment-only") return;
    const status = deps.reviewStatus?.get(input);
    if (
      status?.attemptId !== input.attemptId ||
      status?.attemptHeadSha !== input.reviewedHeadSha ||
      (status?.status !== "pending" && !(allowStopped && status?.status === "stopped"))
    ) {
      throw new Error("STOP_ATTEMPT_MISMATCH: attempt changed or already completed");
    }
  }

  const guard = deps.reviewStopGuard ?? processGuard;
  // PR単位で直列化し、識別子を変えた同一attemptの同時投稿も防ぐ。
  guard.acquire(key, markerKey);
  try {
    assertAttempt(true);
    const client = await deps.getClient(input.owner, input.repo);
    async function verifyTarget() {
      const pr = await getPR(client, input.owner, input.repo, input.prNumber);
      const expectedUrl = `https://github.com/${input.owner}/${input.repo}/pull/${input.prNumber}`;
      if (
        pr.number !== input.prNumber ||
        pr.htmlUrl.toLowerCase() !== expectedUrl.toLowerCase() ||
        pr.state !== "open"
      ) {
        throw new Error("STOP_TARGET_INVALID: expected an open matching pull request");
      }
      const origin = evaluatePullRequestOrigin(deps.allowedAuthors, pullRequestOrigin(pr));
      if (!origin.allowed) throw new Error(`STOP_ORIGIN_REJECTED: ${origin.reason}`);
      if (pr.head.sha !== input.currentHeadSha)
        throw new Error("STOP_HEAD_MISMATCH: current head changed");
    }
    await verifyTarget();
    const ctx = await deps.getWriteContext(input.owner, input.repo);
    assertRepoWritable(ctx.allowedRepos, input.owner, input.repo);
    if (!ctx.appId || !/^[1-9]\d*$/.test(ctx.appId))
      throw new Error(
        "STOP_APP_ID_UNAVAILABLE: numeric GitHub App id required to verify notification author",
      );
    // 完全なページ取得に失敗した場合は投稿しない。他の投稿者のmarkerは重複の証拠にしない。
    const comments = await ctx.client.rest.paginate(ctx.client.rest.issues.listComments, {
      owner: input.owner,
      repo: input.repo,
      issue_number: input.prNumber,
      per_page: 100,
    });
    const matches = comments.filter(
      (comment) =>
        comment.user?.type === "Bot" &&
        String(comment.performed_via_github_app?.id) === ctx.appId &&
        comment.body?.split(/\r?\n/).includes(marker),
    );
    if (matches.length > 1 || (matches.length === 1 && matches[0].body !== body)) {
      throw new Error("STOP_NOTIFICATION_CONFLICT: marker is duplicated or payload changed");
    }
    await verifyTarget();
    assertAttempt(matches.length === 1);
    let commentId = matches[0]?.id;
    if (commentId === undefined) {
      // 停止済みなのにコメントが消えた場合も再投稿しない。
      assertAttempt(false);
      try {
        commentId = await createIssueComment(
          ctx.client,
          input.owner,
          input.repo,
          input.prNumber,
          body,
        );
      } catch (cause) {
        guard.uncertain(markerKey);
        throw new Error(
          "STOP_NOTIFICATION_UNCERTAIN: posting failed or result unknown; read back, do not resend",
          { cause },
        );
      }
      auditWrite(ctx.logger, "review_stop", {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        commentId,
        code: input.code,
      });
    }
    const statusUpdated =
      input.attemptId !== undefined &&
      (deps.reviewStatus?.markStopped(input, {
        attemptId: input.attemptId,
        headSha: input.reviewedHeadSha,
        stop: {
          commentId,
          notificationId: input.notificationId,
          code: input.code,
          currentHeadSha: input.currentHeadSha,
        },
      }) ??
        false);
    return {
      ok: true,
      commentId,
      notification: matches.length ? "existing" : "posted",
      statusUpdated,
      attemptId: input.attemptId ?? null,
    };
  } finally {
    guard.release(key);
  }
}
