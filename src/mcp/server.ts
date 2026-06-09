// Transport-independent MCP server setup

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import { createSubscriptionSession } from "./subscriptions/listen.js";
import { createQueueNotifier } from "./subscriptions/notify.js";
import type { ToolDeps } from "./tool-deps.js";
import {
  APPROVE_PULL_REQUEST_TOOL_NAME,
  approvePullRequestInputSchema,
  approvePullRequestTool,
} from "./tools/approve-pull-request.js";
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
const QUEUE_RESOURCE_MIME_TYPE = "application/json";

export interface McpServerOptions {
  name: string;
  version: string;
}

export interface McpServerDeps extends ToolDeps {
  /** 渡した場合、queue://review/queue resource と subscribe 通知が有効になる */
  queue?: ReviewQueue;
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
  const hasQueue = deps.queue !== undefined;
  const server = new McpServer(
    { name: options.name, version: options.version },
    hasQueue ? { capabilities: { resources: { subscribe: true, listChanged: false } } } : {},
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

  if (deps.queue) {
    const queue = deps.queue;

    const session = createSubscriptionSession();
    const notifier = createQueueNotifier(
      (listener) => queue.onEnqueue(listener),
      (uri) => server.server.sendResourceUpdated({ uri }),
      session,
      QUEUE_RESOURCE_URI,
    );

    const reReviewSession = createSubscriptionSession();
    const reReviewNotifier = createQueueNotifier(
      (listener) => queue.onReReviewRequested(listener),
      (uri) => server.server.sendResourceUpdated({ uri }),
      reReviewSession,
      RE_REVIEW_RESOURCE_URI,
    );

    const prevOnclose = server.server.onclose;
    server.server.onclose = () => {
      try {
        prevOnclose?.();
      } finally {
        notifier.dispose();
        session.dispose();
        reReviewNotifier.dispose();
        reReviewSession.dispose();
      }
    };

    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: QUEUE_RESOURCE_URI,
          name: "Review Queue",
          description:
            "レビュー待ちの PR 一覧。opened / synchronized で enqueue されると notifications/resources/updated が push される。",
          mimeType: QUEUE_RESOURCE_MIME_TYPE,
        },
        {
          uri: RE_REVIEW_RESOURCE_URI,
          name: "Re-review Requests",
          description:
            "再レビュー依頼のみを通知するキュー。re-review-requested で enqueue されたときだけ notifications/resources/updated が push される。",
          mimeType: QUEUE_RESOURCE_MIME_TYPE,
        },
      ],
    }));

    server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === QUEUE_RESOURCE_URI) {
        return {
          contents: [
            {
              uri: QUEUE_RESOURCE_URI,
              mimeType: QUEUE_RESOURCE_MIME_TYPE,
              text: JSON.stringify(queue.list(), null, 2),
            },
          ],
        };
      }
      if (request.params.uri === RE_REVIEW_RESOURCE_URI) {
        return {
          contents: [
            {
              uri: RE_REVIEW_RESOURCE_URI,
              mimeType: QUEUE_RESOURCE_MIME_TYPE,
              text: JSON.stringify(
                queue.list().filter((c) => c.reason === "re-review-requested"),
                null,
                2,
              ),
            },
          ],
        };
      }
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${request.params.uri}`);
    });

    server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      if (request.params.uri === QUEUE_RESOURCE_URI) {
        notifier.handleSubscribe();
      } else if (request.params.uri === RE_REVIEW_RESOURCE_URI) {
        reReviewNotifier.handleSubscribe();
      } else {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${request.params.uri}`);
      }
      return {};
    });

    server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      if (request.params.uri === QUEUE_RESOURCE_URI) {
        notifier.handleUnsubscribe();
      } else if (request.params.uri === RE_REVIEW_RESOURCE_URI) {
        reReviewNotifier.handleUnsubscribe();
      } else {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${request.params.uri}`);
      }
      return {};
    });
  }

  return server;
}
