import { isAllowed, parseAllowlist } from "../policy/allowlist.js";

/** 内部面の操作。tool 名との対応は internal-tools.ts にある。 */
export type ServiceAction = "accept" | "cancel" | "get_result";

const ACTIONS: ReadonlySet<string> = new Set<ServiceAction>(["accept", "cancel", "get_result"]);
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;

interface ServiceEntry {
  actions: ReadonlySet<ServiceAction>;
  repos: readonly string[];
}

export interface ServiceAcl {
  /** サービスが、その操作を呼べるか。repo が分かっている操作では、repo の許可も要る。 */
  allows(subject: string, action: ServiceAction, repo?: { owner: string; repo: string }): boolean;
}

/**
 * 内部面のサービス別アクセスリストを読む。形式（review-raven の REVIEW_RAVEN_SERVICE_ACL と同じ流儀）:
 * `{"services":{"svc-raven":{"actions":["accept","cancel","get_result"],"repos":["owner/*"]}}}`
 * 不正・空の設定は起動を止める（fail-closed）。
 */
export function parseServiceAcl(raw: string): ServiceAcl {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("THREAD_OWL_SERVICE_ACL must be valid JSON");
  }
  const services =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { services?: unknown }).services
      : undefined;
  if (typeof services !== "object" || services === null || Array.isArray(services)) {
    throw new Error('THREAD_OWL_SERVICE_ACL must be {"services":{...}}');
  }
  const entries = Object.entries(services);
  if (entries.length === 0) {
    throw new Error("THREAD_OWL_SERVICE_ACL must list at least one service");
  }

  const table = new Map<string, ServiceEntry>();
  for (const [name, value] of entries) {
    if (!SERVICE_NAME.test(name)) {
      throw new Error(`THREAD_OWL_SERVICE_ACL service name is invalid: '${name}'`);
    }
    const { actions, repos } = (value ?? {}) as { actions?: unknown; repos?: unknown };
    if (
      !Array.isArray(actions) ||
      actions.length === 0 ||
      !actions.every((a) => typeof a === "string" && ACTIONS.has(a))
    ) {
      throw new Error(
        `THREAD_OWL_SERVICE_ACL '${name}' actions must be a non-empty list of: ${[...ACTIONS].join(", ")}`,
      );
    }
    if (!Array.isArray(repos) || repos.length === 0 || !repos.every((r) => typeof r === "string")) {
      throw new Error(`THREAD_OWL_SERVICE_ACL '${name}' repos must be a non-empty list`);
    }
    const key = name.toLowerCase();
    let normalized: string[];
    try {
      // 形式（owner/repo または owner/*）の検証は parseAllowlist に一元化している
      normalized = parseAllowlist(repos.join(",")).repos;
    } catch (error) {
      throw new Error(`THREAD_OWL_SERVICE_ACL '${name}' repos: ${(error as Error).message}`);
    }
    if (table.has(key)) {
      throw new Error(`THREAD_OWL_SERVICE_ACL service name is duplicated: '${name}'`);
    }
    table.set(key, {
      actions: new Set(actions as ServiceAction[]),
      repos: normalized,
    });
  }

  return {
    allows(subject, action, repo) {
      const entry = table.get(subject.toLowerCase());
      if (!entry?.actions.has(action)) {
        return false;
      }
      return repo === undefined || isAllowed(entry.repos, repo.owner, repo.repo);
    },
  };
}
