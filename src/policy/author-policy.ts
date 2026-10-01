// PR の作成者・fork の検証（他者の PR を既定で queue に載せない）

// GitHub の login（ユーザー名）は英数字とハイフンで、先頭・末尾にハイフンを置けない。
// bot は `<name>[bot]` 形式で、正規化の段階で `[bot]` を取り除く。
const LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// login を比較用に正規化する。Mcp-Docker の skill の normalize_login と同じ規則にそろえる。
// 1. ASCII の大文字を小文字にする。
// 2. 末尾が `[bot]` の場合だけ、その suffix を 1 回だけ取り除く（空白の trim や途中の置換はしない）。
// GraphQL と REST で App の login の表記（`[bot]` の有無）が変わるため、同じ identity として扱う。
export function normalizeLogin(login: string): string {
  const lower = login.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return lower.endsWith("[bot]") ? lower.slice(0, -"[bot]".length) : lower;
}

// ALLOWED_AUTHORS（カンマ区切りの login）を正規化する。
// トリム・空エントリ除外・正規化・重複除去を行い、形式不正（wildcard を含む）は fail-fast で throw する。
export function parseAuthorAllowlist(raw: string): string[] {
  const logins = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const normalized = normalizeLogin(entry);
    if (!LOGIN_PATTERN.test(normalized)) {
      throw new Error(
        `ALLOWED_AUTHORS entry must be a GitHub login (wildcards are not allowed): '${entry}'`,
      );
    }
    logins.add(normalized);
  }
  return [...logins];
}

export function isAuthorAllowed(allowedAuthors: readonly string[], login: string): boolean {
  return allowedAuthors.includes(normalizeLogin(login));
}

export interface PullRequestOrigin {
  // 作成者の login。取得できない（アカウントが削除されている、payload に無い）場合は null。
  authorLogin: string | null;
  // head の repository が base と別（fork）か。head の repository が取得できない場合は null。
  fork: boolean | null;
}

export type OriginRejectionReason =
  | "author_allowlist_empty"
  | "author_unknown"
  | "author_not_allowed"
  | "head_repo_unknown"
  | "fork";

export type OriginDecision = { allowed: true } | { allowed: false; reason: OriginRejectionReason };

// PR の作成者と head の repository を検証する。判定できないものは拒否する（fail-closed）。
// allowlist が空（未設定）のときは、信頼する作成者がいないため、すべて拒否する（ALLOWED_REPOS が空のときと同じ流儀）。
// fork は、作成者が許可されていても拒否する。
export function evaluatePullRequestOrigin(
  allowedAuthors: readonly string[],
  origin: PullRequestOrigin,
): OriginDecision {
  if (allowedAuthors.length === 0) return { allowed: false, reason: "author_allowlist_empty" };
  if (origin.authorLogin === null) return { allowed: false, reason: "author_unknown" };
  if (!isAuthorAllowed(allowedAuthors, origin.authorLogin)) {
    return { allowed: false, reason: "author_not_allowed" };
  }
  if (origin.fork === null) return { allowed: false, reason: "head_repo_unknown" };
  if (origin.fork) return { allowed: false, reason: "fork" };
  return { allowed: true };
}

export class PullRequestOriginNotAllowedError extends Error {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reason: OriginRejectionReason;

  constructor(owner: string, repo: string, prNumber: number, reason: OriginRejectionReason) {
    super(`Pull request ${owner}/${repo}#${prNumber} is not allowed: ${reason}`);
    this.name = "PullRequestOriginNotAllowedError";
    this.owner = owner;
    this.repo = repo;
    this.prNumber = prNumber;
    this.reason = reason;
  }
}
