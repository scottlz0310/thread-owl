// Transport-independent MCP server setup

import { McpServer, ResourceNotFoundError } from "@modelcontextprotocol/server";
import type { ReviewQueue } from "../queue/review-queue.js";
import type { PullRequestRef, ReviewStatusStore } from "../queue/review-status.js";
import type { ToolDeps } from "./tool-deps.js";
import {
  APPROVE_PULL_REQUEST_TOOL_NAME,
  approvePullRequestInputSchema,
  approvePullRequestTool,
} from "./tools/approve-pull-request.js";
import {
  ENQUEUE_REVIEW_TOOL_NAME,
  enqueueReviewInputSchema,
  enqueueReviewTool,
} from "./tools/enqueue-review.js";
import { GET_PR_TOOL_NAME, getPrInputSchema, getPrTool } from "./tools/get-pr.js";
import {
  LIST_REVIEW_THREADS_TOOL_NAME,
  listReviewThreadsInputSchema,
  listReviewThreadsTool,
} from "./tools/list-review-threads.js";
import {
  POST_INLINE_COMMENT_TOOL_NAME,
  postInlineCommentInputSchema,
  postInlineCommentTool,
} from "./tools/post-inline-comment.js";
import {
  POST_SUMMARY_TOOL_NAME,
  postSummaryInputSchema,
  postSummaryTool,
} from "./tools/post-summary.js";
import {
  REPLY_THREAD_TOOL_NAME,
  replyThreadInputSchema,
  replyThreadTool,
} from "./tools/reply-thread.js";

export const QUEUE_RESOURCE_URI = "queue://review/queue";
export const RE_REVIEW_RESOURCE_URI = "queue://review/re-review-requests";
export const REVIEW_STATUS_URI_TEMPLATE = "review://status/{owner}/{repo}/{prNumber}";
const JSON_MIME_TYPE = "application/json";
const REVIEW_STATUS_URI_PATTERN = /^review:\/\/status\/([^/]+)\/([^/]+)\/([1-9]\d*)$/i;

// subscriptions/listen の URI フィルタは完全一致のため、通知と resources/list の URI は小文字に正規化する。
export function reviewStatusUri(pr: PullRequestRef): string {
  return `review://status/${pr.owner}/${pr.repo}/${pr.prNumber}`.toLowerCase();
}

function parseReviewStatusUri(uri: string): PullRequestRef | undefined {
  const match = REVIEW_STATUS_URI_PATTERN.exec(uri);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2], prNumber: Number(match[3]) };
}

export interface McpServerOptions {
  name: string;
  version: string;
}

export interface McpServerDeps extends ToolDeps {
  /** 渡した場合、queue://review/* resource が有効になる。通知配信は呼び出し側が ServerNotifier 経由で行う。 */
  queue?: ReviewQueue;
  /** 渡した場合、review://status/* resource が有効になる。通知配信は呼び出し側が ServerNotifier 経由で行う。 */
  reviewStatus?: ReviewStatusStore;
}

function jsonResource(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: JSON_MIME_TYPE, text: JSON.stringify(data, null, 2) }] };
}

// tool 実行結果を MCP CallToolResult（text content）に変換する。失敗時は isError で返す。
export async function runTool(fn: () => Promise<unknown>) {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

export function createMcpServer(deps: McpServerDeps, options: McpServerOptions): McpServer {
  const { queue, reviewStatus } = deps;
  const hasResources = queue !== undefined || reviewStatus !== undefined;
  const server = new McpServer(
    { name: options.name, version: options.version },
    hasResources ? { capabilities: { resources: { subscribe: true, listChanged: false } } } : {},
  );

  server.registerTool(
    GET_PR_TOOL_NAME,
    { description: "PR の基本情報と変更ファイル一覧を取得する", inputSchema: getPrInputSchema },
    (args) => runTool(() => getPrTool(deps, args)),
  );

  server.registerTool(
    LIST_REVIEW_THREADS_TOOL_NAME,
    {
      description: "PR のレビュースレッド一覧（resolved/outdated 状態・コメント含む）を取得する",
      inputSchema: listReviewThreadsInputSchema,
    },
    (args) => runTool(() => listReviewThreadsTool(deps, args)),
  );

  server.registerTool(
    POST_SUMMARY_TOOL_NAME,
    {
      description: "PR 本文へサマリーコメントを投稿する（allowlist 内のみ）",
      inputSchema: postSummaryInputSchema,
    },
    (args) => runTool(() => postSummaryTool(deps, args)),
  );

  server.registerTool(
    POST_INLINE_COMMENT_TOOL_NAME,
    {
      description: "PR にインラインレビューコメントを投稿する（allowlist 内のみ）",
      inputSchema: postInlineCommentInputSchema,
    },
    (args) => runTool(() => postInlineCommentTool(deps, args)),
  );

  server.registerTool(
    REPLY_THREAD_TOOL_NAME,
    {
      description: "レビュースレッドへ返信する（allowlist 内のみ）",
      inputSchema: replyThreadInputSchema,
    },
    (args) => runTool(() => replyThreadTool(deps, args)),
  );

  server.registerTool(
    APPROVE_PULL_REQUEST_TOOL_NAME,
    {
      description: "PR を APPROVE する（allowlist 内のみ）",
      inputSchema: approvePullRequestInputSchema,
    },
    (args) => runTool(() => approvePullRequestTool(deps, args)),
  );

  if (queue) {
    server.registerTool(
      ENQUEUE_REVIEW_TOOL_NAME,
      {
        description:
          "webhook 以外の正規経路で PR を review queue に enqueue する（allowlist 内のみ）",
        inputSchema: enqueueReviewInputSchema,
      },
      (args) => runTool(() => enqueueReviewTool({ ...deps, queue }, args)),
    );
  }

  if (!hasResources) {
    return server;
  }

  server.server.setRequestHandler("resources/list", async () => ({
    resources: [
      ...(queue
        ? [
            {
              uri: QUEUE_RESOURCE_URI,
              name: "Review Queue",
              description:
                "レビュー待ちの PR 一覧。opened / synchronized で enqueue されると notifications/resources/updated が push される。",
              mimeType: JSON_MIME_TYPE,
            },
            {
              uri: RE_REVIEW_RESOURCE_URI,
              name: "Re-review Requests",
              description:
                "再レビュー依頼のみを通知するキュー。re-review-requested で enqueue されたときだけ notifications/resources/updated が push される。",
              mimeType: JSON_MIME_TYPE,
            },
          ]
        : []),
      ...(reviewStatus?.list() ?? []).map((status) => ({
        uri: reviewStatusUri(status),
        name: `Review Status ${status.owner}/${status.repo}#${status.prNumber}`,
        mimeType: JSON_MIME_TYPE,
      })),
    ],
  }));

  if (reviewStatus) {
    server.server.setRequestHandler("resources/templates/list", async () => ({
      resourceTemplates: [
        {
          uriTemplate: REVIEW_STATUS_URI_TEMPLATE,
          name: "Review Status",
          description:
            "PR 単位のレビュー状態。enqueue_review で pending に初期化され、post_summary_comment（reviewed）/ approve_pull_request（approved）で notifications/resources/updated が push される。",
          mimeType: JSON_MIME_TYPE,
        },
      ],
    }));
  }

  server.server.setRequestHandler("resources/read", async (request) => {
    const { uri } = request.params;
    if (queue && uri === QUEUE_RESOURCE_URI) {
      return jsonResource(uri, queue.list());
    }
    if (queue && uri === RE_REVIEW_RESOURCE_URI) {
      return jsonResource(
        uri,
        queue.list().filter((c) => c.reason === "re-review-requested"),
      );
    }
    const pr = parseReviewStatusUri(uri);
    const status = pr && reviewStatus?.get(pr);
    if (status) {
      return jsonResource(uri, status);
    }
    throw new ResourceNotFoundError(uri, `Unknown resource URI: ${uri}`);
  });

  return server;
}
