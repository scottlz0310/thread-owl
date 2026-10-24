import type { Logger } from "../config/logging.js";
import { type ContractSchemaName, validateContract } from "../contract/validate.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import type { ReviewStatusStore } from "../queue/review-status.js";
import { ContractError } from "./errors.js";
import type { ReviewCycleLedger } from "./ledger.js";
import type { OriginChecker } from "./origin.js";
import type { ResultBinder } from "./result-binder.js";
import type { ServiceAcl, ServiceAction } from "./service-acl.js";

/** 内部面（raven → owl）の tool 名と、ACL の操作・入力 schema の対応。 */
export const INTERNAL_TOOLS = {
  accept_review_candidate: { action: "accept", input: "accept_review_candidate.input" },
  cancel_review_candidate: { action: "cancel", input: "cancel_review_candidate.input" },
  get_review_result: { action: "get_result", input: "get_review_result.input" },
} as const satisfies Record<string, { action: ServiceAction; input: ContractSchemaName }>;

export type InternalToolName = keyof typeof INTERNAL_TOOLS;

export interface ErrorEnvelope {
  schemaVersion: 1;
  error: { code: string; message: string; retryable: boolean };
}

export type ToolOutcome =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; envelope: ErrorEnvelope };

export interface InternalToolDeps {
  ledger: ReviewCycleLedger;
  acl: ServiceAcl;
  checkOrigin: OriginChecker;
  /** 受け付けた候補を載せる既存の review queue。reviewer の起動と購読の経路は旧経路と共通。 */
  queue: ReviewQueue;
  reviewStatus?: ReviewStatusStore;
  resolveInstallationId: (owner: string, repo: string) => Promise<number>;
  /** 結果投稿の束縛。取消の前に、結果不明の書込みを GitHub 上の投稿で照合する。 */
  binder: ResultBinder;
  logger: Logger;
}

function envelope(error: ContractError): ToolOutcome {
  return {
    ok: false,
    envelope: {
      schemaVersion: 1,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    },
  };
}

/**
 * 内部 tool を 1 回実行する。入力は契約 schema（未知の項目は拒否）で検証し、サービス主体は
 * gateway が検証した identity から得る（入力の自己申告は使わない）。失敗は契約のエラー envelope で返し、
 * 想定外の例外は内容を返さず、再送可能な UNAVAILABLE にする。
 */
export async function callInternalTool(
  deps: InternalToolDeps,
  principal: string,
  name: InternalToolName,
  args: unknown,
): Promise<ToolOutcome> {
  try {
    const tool = INTERNAL_TOOLS[name];
    const validation = validateContract(tool.input, args);
    if (!validation.ok) {
      return envelope(new ContractError("INVALID_ARGUMENT", validation.errors.slice(0, 500)));
    }
    const input = args as Record<string, unknown>;
    return { ok: true, output: await run(deps, principal, name, input) };
  } catch (error) {
    if (error instanceof ContractError) {
      return envelope(error);
    }
    deps.logger.error("internal.tool.error", {
      event: "internal.tool.error",
      tool: name,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return envelope(new ContractError("UNAVAILABLE", "内部エラーのため処理できない"));
  }
}

async function run(
  {
    ledger,
    acl,
    checkOrigin,
    queue,
    reviewStatus,
    resolveInstallationId,
    binder,
  }: InternalToolDeps,
  principal: string,
  name: InternalToolName,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { action } = INTERNAL_TOOLS[name];
  const denied = () => new ContractError("PERMISSION_DENIED", "この操作は許可されていない");

  switch (name) {
    case "accept_review_candidate": {
      const accept = {
        cycleId: input.cycleId as string,
        round: input.round as number,
        owner: input.owner as string,
        repo: input.repo as string,
        prNumber: input.prNumber as number,
        headSha: input.headSha as string,
        reason: input.reason as "opened" | "synchronized" | "re-review-requested",
        sourceId: input.sourceId as string | null,
      };
      if (!acl.allows(principal, action, accept)) {
        throw denied();
      }
      const origin = await checkOrigin(accept.owner, accept.repo, accept.prNumber);
      if (!origin.allowed) {
        throw new ContractError("ORIGIN_REJECTED", `候補を受け付けない PR: ${origin.reason}`);
      }
      // 失敗しうる外部呼び出し（installation の解決）は、台帳へ永続する前に済ませる。
      const installationId = await resolveInstallationId(accept.owner, accept.repo);
      const accepted = ledger.accept({ ...accept, installationId });
      // 再送（duplicate）は queue に載せ直さない。再起動後は台帳から queue を再構築する。
      if (!accepted.duplicate) {
        queue.enqueue({
          owner: accept.owner,
          repo: accept.repo,
          prNumber: accept.prNumber,
          installationId,
          queuedAt: new Date(),
          reason: accept.reason,
          cycle: {
            candidateId: accepted.candidateId,
            cycleId: accept.cycleId,
            round: accept.round,
            headSha: accept.headSha,
          },
        });
        const pr = { owner: accept.owner, repo: accept.repo, prNumber: accept.prNumber };
        reviewStatus?.markPending(pr);
        // 結果の投稿時に、この受付の status のラウンドを使う（投稿時に現在のラウンドを引き直さない）。
        binder.noteStatusRound(accept.cycleId, pr);
      }
      return { schemaVersion: 1, ...accepted };
    }
    case "cancel_review_candidate": {
      const cancel = {
        cycleId: input.cycleId as string,
        round: input.round as number,
        headSha: input.headSha as string,
        cancelId: input.cancelId as string,
      };
      // 入力に repo が無いため、受付済みなら対象 repo も認可する。未受理の cycle は操作の認可だけ。
      if (!acl.allows(principal, action, ledger.findByCycle(cancel.cycleId))) {
        throw denied();
      }
      // 停止後の再起動などで結果不明のまま残った書込みは、取消の前に GitHub 上の投稿で照合する
      // （投稿が見つかれば CANCEL_RESULT_POSTED、無ければ書込みを解除して取消を確定できる）。
      // このプロセスが書込み中のものは対象外で、取消は保留（CANCEL_UNCONFIRMED）のまま。
      await binder.reconcileStale(cancel.cycleId);
      let done: ReturnType<ReviewCycleLedger["cancel"]>;
      try {
        done = ledger.cancel(cancel);
      } catch (error) {
        // 取消の要求は永続済みで、旧候補は起動できない。reviewer が走り出さないよう queue から外す。
        // 結果の投稿が先着した場合（CANCEL_RESULT_POSTED）は、候補を外さない。
        if (error instanceof ContractError && error.code === "CANCEL_UNCONFIRMED") {
          queue.removeCycle(cancel.cycleId);
        }
        throw error;
      }
      queue.removeCycle(cancel.cycleId);
      return {
        schemaVersion: 1,
        cancelId: done.cancelId,
        acknowledged: true,
        candidateStatus: done.candidateStatus,
        githubWriteReconciled: true,
      };
    }
    case "get_review_result": {
      const cycleId = input.cycleId as string;
      if (!acl.allows(principal, action, ledger.findByCycle(cycleId))) {
        throw denied();
      }
      return { schemaVersion: 1, result: ledger.getResult(cycleId, input.candidateId as string) };
    }
  }
}
