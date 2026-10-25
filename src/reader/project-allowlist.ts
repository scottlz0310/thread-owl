// PR の base ref にあるプロジェクト固有の allowlist ファイルの検証。
//
// PR の head や作業ツリーは参照しない。PR が、自分のコメントに適用される allowlist を広げられないようにするため。

import { isNormalizedLogin, normalizeLogin } from "../policy/author-policy.js";

export const PROJECT_FILE_PATH = ".review-raven/trusted-comment-authors.json";

// エラーメッセージが、拒否した値を繰り返す長さの上限。長い値で、失敗応答が際限なく長くならないようにする。
const MAX_EXCERPT = 64;

function excerpt(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const chars = Array.from(text);
  return chars.length > MAX_EXCERPT
    ? `${JSON.stringify(chars.slice(0, MAX_EXCERPT).join(""))}...`
    : JSON.stringify(text);
}

// 検証して、サーバーの allowlist に加える login（正規化済み）を返す。
// 形式が壊れたファイルは、「追加なし」と読まずに throw する（ゲートを止める）。
export function parseProjectFile(data: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(
      `${PROJECT_FILE_PATH} is not a valid allowlist file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PROJECT_FILE_PATH} is not a valid allowlist file: expected a JSON object`);
  }
  const file = parsed as Record<string, unknown>;
  for (const key of Object.keys(file)) {
    if (key !== "version" && key !== "additional_logins") {
      throw new Error(
        `${PROJECT_FILE_PATH} is not a valid allowlist file: unknown field ${excerpt(key)}`,
      );
    }
  }
  if (file.version !== 1) {
    throw new Error(`${PROJECT_FILE_PATH}: version must be 1`);
  }
  const entries = file.additional_logins;
  if (!Array.isArray(entries)) {
    throw new Error(`${PROJECT_FILE_PATH}: additional_logins must be an array`);
  }

  const logins: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (typeof raw !== "string") {
      throw new Error(
        `${PROJECT_FILE_PATH}: additional_logins entry must be a GitHub login (wildcards are not allowed): ${excerpt(raw)}`,
      );
    }
    const normalized = normalizeLogin(raw);
    if (!isNormalizedLogin(normalized)) {
      throw new Error(
        `${PROJECT_FILE_PATH}: additional_logins entry must be a GitHub login (wildcards are not allowed): ${excerpt(raw)}`,
      );
    }
    if (seen.has(normalized)) {
      throw new Error(
        `${PROJECT_FILE_PATH}: additional_logins has a duplicate after normalization: ${excerpt(raw)}`,
      );
    }
    seen.add(normalized);
    logins.push(normalized);
  }
  return logins;
}
