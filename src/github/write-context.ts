// Shared context and audit logging for GitHub write operations

import type { Logger } from "../config/logging.js";
import type { GitHubClient } from "./client.js";

// write 操作の共通コンテキスト。将来 policy / audit / dryRun を足せるよう単純に保つ。
export interface WriteContext {
  client: GitHubClient;
  allowedRepos: readonly string[];
  logger: Logger;
}

// write 操作の監査ログ。body 全文・token 等の機密は残さず、操作種別とメタ情報のみ記録する。
export function auditWrite(logger: Logger, action: string, meta: Record<string, unknown>): void {
  logger.info(`review.${action}`, { event: `review.${action}`, ...meta });
}
