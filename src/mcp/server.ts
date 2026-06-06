// Transport-independent MCP server setup

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./tool-deps.js";
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

export interface McpServerOptions {
  name: string;
  version: string;
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

export function createMcpServer(deps: ToolDeps, options: McpServerOptions): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });

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

  return server;
}
