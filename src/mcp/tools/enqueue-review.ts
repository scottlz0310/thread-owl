// MCP tool: enqueue_review
// webhook 以外の正規 enqueue 入口。mcp-gateway の認証境界を通る呼び出し前提で、tool 側での追加認証は行わない。
// requestedBy は呼び出し側の自己申告で信頼できないため、PR の作成者は GitHub API から取得して検証する。

import { z } from "zod";
import { getPR } from "../../github/pull-requests.js";
import { isAllowed, RepositoryNotAllowedError } from "../../policy/allowlist.js";
import {
  evaluatePullRequestOrigin,
  type PullRequestOrigin,
  PullRequestOriginNotAllowedError,
  pullRequestOrigin,
} from "../../policy/author-policy.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";

export const ENQUEUE_REVIEW_TOOL_NAME = "enqueue_review";

export const enqueueReviewInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  reason: z.enum(["opened", "synchronized", "re-review-requested"]),
  requestedBy: z.string().optional(),
};

type EnqueueReviewInput = z.infer<z.ZodObject<typeof enqueueReviewInputSchema>>;

export interface EnqueueReviewToolDeps extends ToolDeps {
  queue: ReviewQueue;
  reviewStatus?: ReviewStatusStore;
}

// 作成者・fork の照合に使う項目を、PR から読む。allowlist が空なら、どの作成者も許可されないため、PR を取得しない。
async function readOrigin(
  deps: EnqueueReviewToolDeps,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestOrigin> {
  if (deps.allowedAuthors.length === 0) return { authorLogin: null, fork: null };
  const client = await deps.getClient(owner, repo);
  return pullRequestOrigin(await getPR(client, owner, repo, prNumber));
}

export async function enqueueReviewTool(deps: EnqueueReviewToolDeps, input: EnqueueReviewInput) {
  const { owner, repo, prNumber, reason, requestedBy } = input;

  if (!isAllowed(deps.allowedRepos, owner, repo)) {
    throw new RepositoryNotAllowedError(owner, repo);
  }

  // queue に載せる前に、PR を取得して作成者・fork を照合する。allowlist が空（未設定）なら、PR を取得せずに拒否する。
  // 取得に失敗したら例外のまま伝播し、enqueue しない（fail-closed）。
  const origin = await readOrigin(deps, owner, repo, prNumber);
  const { authorLogin } = origin;
  const decision = evaluatePullRequestOrigin(deps.allowedAuthors, origin);
  if (!decision.allowed) {
    // 拒否は監査ログに残す。作成者の login は記録するが、本文は記録しない。
    deps.logger.warn("enqueue_review.origin.rejected", {
      event: "enqueue_review.origin.rejected",
      owner,
      repo,
      prNumber,
      reason: decision.reason,
      authorLogin,
    });
    throw new PullRequestOriginNotAllowedError(owner, repo, prNumber, decision.reason);
  }

  const installationId = await deps.resolveInstallationId(owner, repo);

  deps.queue.enqueue({
    owner,
    repo,
    prNumber,
    installationId,
    queuedAt: new Date(),
    reason,
    ...(reason === "re-review-requested" && requestedBy !== undefined ? { requestedBy } : {}),
  });
  deps.reviewStatus?.markPending({ owner, repo, prNumber });

  return { ok: true };
}
