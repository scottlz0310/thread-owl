import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLedgerIngest } from "./ingest.js";
import { type IngestMessage, ReviewCycleLedger } from "./ledger.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const candidate: IngestMessage = {
  sourceId: "delivery:0f1e2d3c-0001",
  owner: "org",
  repo: "repo",
  prNumber: 5,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  reason: "opened",
  delivery: "webhook",
};

let ledger: ReviewCycleLedger;

beforeEach(() => {
  vi.clearAllMocks();
  ledger = new ReviewCycleLedger({ path: ":memory:" });
});

afterEach(() => {
  ledger.close();
});

describe("createLedgerIngest", () => {
  test("候補を outbox に積み、同じ sourceId の再記録は重複として積み直さない", () => {
    const ingest = createLedgerIngest(ledger, logger);
    ingest.record(candidate);
    ingest.record(candidate);
    expect(ledger.dueIngestMessages()).toHaveLength(1);
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      "webhook.ingest.recorded",
      expect.objectContaining({ sourceId: candidate.sourceId, duplicate: false }),
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      "webhook.ingest.recorded",
      expect.objectContaining({ duplicate: true }),
    );
  });

  test.each<[string, Partial<IngestMessage>]>([
    ["HEAD の書式が違う", { headSha: "ABC" }],
    ["owner が大文字", { owner: "Org" }],
    ["sourceId が空", { sourceId: "" }],
    ["PR 番号が 0", { prNumber: 0 }],
  ])("契約に適合しない候補（%s）は積まず、ログに残す", (_name, override) => {
    createLedgerIngest(ledger, logger).record({ ...candidate, ...override });
    expect(ledger.dueIngestMessages()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "webhook.ingest.skipped",
      expect.objectContaining({ reason: "contract_violation" }),
    );
  });

  test("台帳の書込みが失敗したら、握りつぶさず例外のまま伝播する", () => {
    ledger.close();
    expect(() => createLedgerIngest(ledger, logger).record(candidate)).toThrow();
    ledger = new ReviewCycleLedger({ path: ":memory:" });
  });
});
