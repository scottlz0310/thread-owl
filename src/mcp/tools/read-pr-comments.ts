// MCP tool: read_pr_comments
//
// PR の review thread のコメント・review body・issue comment の本文を、投稿者を検証した上で返す。
// 「メタデータ全ページ → 投稿者検証 → 本文」の順をツール側で強制する（契約は src/contract/v1/reader）。
// list_review_threads は本文を無検証で返すため、他者が書き得るコメントを読むときは、こちらを使う。

import { z } from "zod";
import { createGitHubReaderSource } from "../../reader/github-source.js";
import {
  type ErrorEnvelope,
  type ReaderOutput,
  toErrorEnvelope,
  toOutput,
} from "../../reader/output.js";
import { ReaderGateError, readComments } from "../../reader/reader.js";
import type { ToolDeps } from "../tool-deps.js";

export const READ_PR_COMMENTS_TOOL_NAME = "read_pr_comments";

export const READ_PR_COMMENTS_DESCRIPTION =
  "PR の review thread のコメント・review body・issue comment の本文を、投稿者を検証した上で返す。" +
  "メタデータ(全ページ・resolved を含む)→サーバーの allowlist(TRUSTED_COMMENT_AUTHORS)と base ref のプロジェクト allowlist による投稿者検証→本文の順をツール側で強制し、" +
  "許可外の投稿者・特定できない投稿者が 1 件でもあれば、本文を取得せずエラー(UNTRUSTED_COMMENT / AUTHOR_CHECK_FAILED)を返す。" +
  "検証後に変わった(追加・編集・投稿者や head の変化)本文は返さず、取り直し、変わり続ければ SNAPSHOT_CHANGED を返す。" +
  "失敗の応答に本文は含まない。成功の snapshotId は、後の再取得との比較に使う。" +
  "TRUSTED_COMMENT_AUTHORS が空なら TRUSTED_AUTHORS_NOT_CONFIGURED で止まる。契約は review-raven の docs/design/contracts/reader。";

export const readPrCommentsInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
};

type ReadPrCommentsInput = z.infer<z.ZodObject<typeof readPrCommentsInputSchema>>;

export type ReadPrCommentsResult =
  | { isError: false; payload: ReaderOutput }
  | { isError: true; payload: ErrorEnvelope };

// ゲートが止めたときは、契約の envelope を返す。GitHub の認証・通信の失敗などは、そのまま throw する
// （ゲートの code に置き換えない）。
export async function readPrCommentsTool(
  deps: ToolDeps,
  input: ReadPrCommentsInput,
): Promise<ReadPrCommentsResult> {
  const source = createGitHubReaderSource(() => deps.getClient(input.owner, input.repo), input);
  try {
    const result = await readComments(source, deps.trustedCommentAuthors);
    return { isError: false, payload: toOutput(result) };
  } catch (error) {
    if (error instanceof ReaderGateError) {
      return { isError: true, payload: toErrorEnvelope(error) };
    }
    throw error;
  }
}
