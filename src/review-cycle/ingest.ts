import type { Logger } from "../config/logging.js";
import { validateContract } from "../contract/validate.js";
import type { IngestMessage, ReviewCycleLedger } from "./ledger.js";

/**
 * webhook・コメント由来の候補を、review-raven の共通受付へ渡すために記録する窓口。
 * 旧経路の queue への投入はそのまま行い、これは追加の記録（raven が cycle を作り、候補を送り返す）。
 */
export interface CandidateIngest {
  record(candidate: IngestMessage): void;
}

/**
 * 台帳の outbox に積む。sourceId（配送 ID・コメント ID）で冪等で、配送の再送や GitHub の再配信で増えない。
 * 契約に適合しない候補（HEAD が読めないなど）は送れないため、ログに残して積まない。
 * 台帳の書込みの失敗は、握りつぶさず例外のまま伝播する（webhook が 500 を返し、GitHub が再配信する）。
 */
export function createLedgerIngest(ledger: ReviewCycleLedger, logger: Logger): CandidateIngest {
  return {
    record(candidate) {
      const valid = validateContract("ingest_review_candidate.input", {
        schemaVersion: 1,
        ...candidate,
      });
      if (!valid.ok) {
        logger.warn("webhook.ingest.skipped", {
          event: "webhook.ingest.skipped",
          sourceId: candidate.sourceId,
          owner: candidate.owner,
          repo: candidate.repo,
          prNumber: candidate.prNumber,
          reason: "contract_violation",
        });
        return;
      }
      const recorded = ledger.enqueueIngest(candidate);
      logger.info("webhook.ingest.recorded", {
        event: "webhook.ingest.recorded",
        sourceId: candidate.sourceId,
        owner: candidate.owner,
        repo: candidate.repo,
        prNumber: candidate.prNumber,
        delivery: candidate.delivery,
        duplicate: !recorded,
      });
    },
  };
}
