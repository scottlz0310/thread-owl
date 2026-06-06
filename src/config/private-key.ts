// GitHub App の秘密鍵を複数の受け取り形式から解決する。
// PEM は改行が意味を持つ secret のため、改行が壊れにくい形式を優先する。
// 優先順位: FILE（ファイルパス）> B64（base64）> raw（\n エスケープ復元・後方互換）。

import { readFileSync } from "node:fs";

export type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

export function loadGitHubAppPrivateKey(
  env: Record<string, string | undefined>,
  readFile: ReadFile = defaultReadFile,
): string | undefined {
  const file = env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (file) {
    return readFile(file);
  }

  const b64 = env.GITHUB_APP_PRIVATE_KEY_B64;
  if (b64) {
    return Buffer.from(b64, "base64").toString("utf8");
  }

  const raw = env.GITHUB_APP_PRIVATE_KEY;
  if (raw) {
    return raw.replace(/\\n/g, "\n");
  }

  return undefined;
}
