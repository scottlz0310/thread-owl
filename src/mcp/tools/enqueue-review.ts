// MCP tool: enqueue_review
// webhook 以外の正規 enqueue 入口。mcp-gateway の認証境界を通る呼び出し前提で、tool 側での追加認証は行わない。

import { z } from "zod";
import { isAllowed, RepositoryNotAllowedError } from "../../policy/allowlist.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
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
}

export async function enqueueReviewTool(deps: EnqueueReviewToolDeps, input: EnqueueReviewInput) {
  const { owner, repo, prNumber, reason, requestedBy } = input;

  if (!isAllowed(deps.allowedRepos, owner, repo)) {
    throw new RepositoryNotAllowedError(owner, repo);
  }

  const installationId = await deps.resolveInstallationId(owner, repo);

  deps.queue.enqueue({
    owner,
    repo,
    prNumber,
    installationId,
    queuedAt: new Date(),
    reason,
    ...(requestedBy !== undefined ? { requestedBy } : {}),
  });

  return { ok: true };
}
