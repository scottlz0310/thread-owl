import { parseAllowlist } from "../policy/allowlist.js";
import { loadGitHubAppPrivateKey } from "./private-key.js";
import { appConfigSchema } from "./schema.js";
import type { AppConfig } from "./schema.js";

export type { AppConfig };

export function loadEnv(env: Record<string, string | undefined> = process.env): AppConfig {
  const raw = {
    github: {
      appId: env.GITHUB_APP_ID,
      // 秘密鍵は FILE > B64 > raw の優先順位で解決する（private-key.ts 参照）
      privateKey: loadGitHubAppPrivateKey(env),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    },
    policy: {
      // ALLOWED_REPOS の正規化・形式検証は parseAllowlist に集約する（policy/allowlist.ts 参照）
      allowedRepos: parseAllowlist(env.ALLOWED_REPOS ?? "").repos,
    },
    server: {
      port: env.PORT !== undefined ? Number(env.PORT) : 3000,
      // 空文字列は schema の default が効かないため undefined に正規化する。
      // 空 HOST のまま serve すると Node が :: にバインドし localhost 境界が破れるのを防ぐ。
      host: env.HOST || undefined,
    },
    logging: {
      level: env.LOG_LEVEL,
    },
  };

  const result = appConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${result.error.message}`);
  }
  return result.data;
}
