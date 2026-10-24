import type { Logger } from "../config/logging.js";
import { abortableSleep } from "./abortable-sleep.js";
import type { PurgeReport, ReviewCycleLedger } from "./ledger.js";

/** 保持期限の確認の間隔。期限は日単位なので、頻繁には要らない。 */
export const RETENTION_INTERVAL_MS = 3_600_000;

export interface RetentionDeps {
  ledger: ReviewCycleLedger;
  retentionDays: number;
  logger: Logger;
  /** 台帳から候補を削除した cycleId。in-memory の queue など、台帳と同期すべきものを外すために使う。 */
  onPurged?: (cycleIds: string[]) => void;
}

/** 期限を過ぎた行を 1 回削除し、削除があればログに残し、削除した候補を onPurged に渡す。 */
export function purgeOnce(deps: RetentionDeps): PurgeReport {
  const { ledger, retentionDays, logger, onPurged } = deps;
  const report = ledger.purgeExpired(retentionDays);
  if (report.purgedCycleIds.length > 0) {
    onPurged?.(report.purgedCycleIds);
  }
  const { purgedCycleIds: _ids, ...counts } = report;
  if (Object.values(counts).some((count) => count > 0)) {
    logger.info("internal.retention.purged", { event: "internal.retention.purged", ...counts });
  }
  return report;
}

/**
 * 期限を過ぎた行を 1 回削除する。失敗は握りつぶさずログに残し（台帳の書込みの一時的なロックなど）、
 * 例外としては投げない（起動や次の周期の再試行を止めないため）。削除できたら true。
 */
export function purgeSafely(deps: RetentionDeps): boolean {
  try {
    purgeOnce(deps);
    return true;
  } catch (error) {
    deps.logger.error("internal.retention.error", {
      event: "internal.retention.error",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

/**
 * 起動時と、以後一定間隔で、保持期限を過ぎた行を台帳から削除する。signal が中断されたら止まる。
 * 失敗は握りつぶさずログに残し、次の周期で再試行する。
 */
export async function runRetention(
  deps: RetentionDeps,
  signal: AbortSignal,
  intervalMs = RETENTION_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    purgeSafely(deps);
    if (signal.aborted) {
      return;
    }
    await abortableSleep(intervalMs, signal);
  }
}
