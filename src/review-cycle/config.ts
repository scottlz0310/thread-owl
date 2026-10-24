import { validateRavenEndpoint } from "./raven-client.js";
import { parseServiceAcl, type ServiceAcl } from "./service-acl.js";

export interface InternalSurfaceConfig {
  /** 永続台帳の SQLite ファイル。 */
  ledgerPath: string;
  /** gateway と共有する proxy secret。内部面の Bearer として検証する。 */
  proxySecret: string;
  serviceAcl: ServiceAcl;
  /** 公開の MCP パスとは別の、内部面専用のパス。 */
  path: string;
  /** 台帳の保持期間（日）。契約の下限（30 日）以上。取消記録は確定時刻から、要求中の取消は削除しない。 */
  retentionDays: number;
  /** 結果を review-raven へ送る配送。未設定なら送らない（raven は get_review_result で引ける）。 */
  delivery?: { endpoint: string; token: string; intervalMs: number };
}

const DEFAULT_INTERNAL_PATH = "/internal/mcp";
const MIN_SECRET_LENGTH = 16;

/**
 * review-raven との内部面の設定を読む。次の 3 つはすべて設定するか、すべて未設定にする
 * （一部だけの設定は、内部面を意図せず無認証・無永続にしないため、起動を止める）:
 * - THREAD_OWL_LEDGER_PATH
 * - THREAD_OWL_INTERNAL_PROXY_SECRET
 * - THREAD_OWL_SERVICE_ACL
 * 未設定なら内部面は無効（undefined）。
 */
export function loadInternalSurfaceConfig(
  env: Record<string, string | undefined>,
  publicMcpPath: string,
): InternalSurfaceConfig | undefined {
  const ledgerPath = env.THREAD_OWL_LEDGER_PATH?.trim() || undefined;
  const proxySecret = env.THREAD_OWL_INTERNAL_PROXY_SECRET?.trim() || undefined;
  const rawAcl = env.THREAD_OWL_SERVICE_ACL?.trim() || undefined;
  if (ledgerPath === undefined && proxySecret === undefined && rawAcl === undefined) {
    return undefined;
  }
  if (ledgerPath === undefined || proxySecret === undefined || rawAcl === undefined) {
    throw new Error(
      "THREAD_OWL_LEDGER_PATH, THREAD_OWL_INTERNAL_PROXY_SECRET and THREAD_OWL_SERVICE_ACL must be set together",
    );
  }
  if (proxySecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `THREAD_OWL_INTERNAL_PROXY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  const path = env.THREAD_OWL_INTERNAL_MCP_PATH?.trim() || DEFAULT_INTERNAL_PATH;
  if (!path.startsWith("/")) {
    throw new Error("THREAD_OWL_INTERNAL_MCP_PATH must start with '/'");
  }
  const normalize = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  if (normalize(path) === normalize(publicMcpPath)) {
    throw new Error("THREAD_OWL_INTERNAL_MCP_PATH must differ from MCP_HTTP_PATH");
  }
  return {
    ledgerPath,
    proxySecret,
    serviceAcl: parseServiceAcl(rawAcl),
    path: normalize(path),
    retentionDays: loadRetentionDays(env),
    delivery: loadDeliveryConfig(env),
  };
}

const DEFAULT_DELIVERY_INTERVAL_SEC = 5;

/**
 * 結果を review-raven へ送る配送の設定。URL と資格情報は同時に設定するか、どちらも設定しない
 * （片方だけは起動を止める）。URL は https、または loopback 上の http のみ。
 */
function loadDeliveryConfig(
  env: Record<string, string | undefined>,
): InternalSurfaceConfig["delivery"] {
  const url = env.THREAD_OWL_RAVEN_INTERNAL_URL?.trim() || undefined;
  const token = env.THREAD_OWL_RAVEN_INTERNAL_TOKEN?.trim() || undefined;
  if (url === undefined && token === undefined) {
    return undefined;
  }
  if (url === undefined || token === undefined) {
    throw new Error(
      "THREAD_OWL_RAVEN_INTERNAL_URL and THREAD_OWL_RAVEN_INTERNAL_TOKEN must be set together",
    );
  }
  const rawInterval = env.THREAD_OWL_DELIVERY_INTERVAL_SEC?.trim();
  const seconds = rawInterval ? Number(rawInterval) : DEFAULT_DELIVERY_INTERVAL_SEC;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("THREAD_OWL_DELIVERY_INTERVAL_SEC must be an integer within 1..3600");
  }
  return { endpoint: validateRavenEndpoint(url), token, intervalMs: seconds * 1000 };
}

/** 契約の設定（settings.schema.json）の下限。取消記録は旧受付の再送可能期間以上でなければならない。 */
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

function loadRetentionDays(env: Record<string, string | undefined>): number {
  const raw = env.THREAD_OWL_RETENTION_DAYS?.trim();
  if (!raw) {
    return MIN_RETENTION_DAYS;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new Error(
      `THREAD_OWL_RETENTION_DAYS must be an integer within ${MIN_RETENTION_DAYS}..${MAX_RETENTION_DAYS}`,
    );
  }
  return days;
}
