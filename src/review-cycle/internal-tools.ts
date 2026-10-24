import type { Logger } from "../config/logging.js";
import { type ContractSchemaName, validateContract } from "../contract/validate.js";
import { ContractError } from "./errors.js";
import type { ReviewCycleLedger } from "./ledger.js";
import type { OriginChecker } from "./origin.js";
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
  { ledger, acl, checkOrigin }: InternalToolDeps,
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
      return { schemaVersion: 1, ...ledger.accept(accept) };
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
      const done = ledger.cancel(cancel);
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
