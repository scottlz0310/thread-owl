import type { Logger } from "../config/logging.js";
import { abortableSleep } from "./abortable-sleep.js";
import type { ReviewCycleLedger } from "./ledger.js";

/** 保持期限の確認の間隔。期限は日単位なので、頻繁には要らない。 */
export const RETENTION_INTERVAL_MS = 3_600_000;

/**
 * 起動時と、以後一定間隔で、保持期限を過ぎた行を台帳から削除する。signal が中断されたら止まる。
 * 失敗は握りつぶさずログに残し（台帳の書込みの失敗など）、次の周期で再試行する。
 */
export async function runRetention(
  deps: { ledger: ReviewCycleLedger; retentionDays: number; logger: Logger },
  signal: AbortSignal,
  intervalMs = RETENTION_INTERVAL_MS,
): Promise<void> {
  const { ledger, retentionDays, logger } = deps;
  while (!signal.aborted) {
    try {
      const report = ledger.purgeExpired(retentionDays);
      if (Object.values(report).some((count) => count > 0)) {
        logger.info("internal.retention.purged", { event: "internal.retention.purged", ...report });
      }
    } catch (error) {
      logger.error("internal.retention.error", {
        event: "internal.retention.error",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    if (signal.aborted) {
      return;
    }
    await abortableSleep(intervalMs, signal);
  }
}
