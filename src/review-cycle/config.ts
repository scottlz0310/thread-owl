import { parseServiceAcl, type ServiceAcl } from "./service-acl.js";

export interface InternalSurfaceConfig {
  /** 永続台帳の SQLite ファイル。 */
  ledgerPath: string;
  /** gateway と共有する proxy secret。内部面の Bearer として検証する。 */
  proxySecret: string;
  serviceAcl: ServiceAcl;
  /** 公開の MCP パスとは別の、内部面専用のパス。 */
  path: string;
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
  return { ledgerPath, proxySecret, serviceAcl: parseServiceAcl(rawAcl), path: normalize(path) };
}
