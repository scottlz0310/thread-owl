import { appConfigSchema } from "./schema.js";
import type { AppConfig } from "./schema.js";

export type { AppConfig };

export function loadEnv(env: Record<string, string | undefined> = process.env): AppConfig {
  const raw = {
    github: {
      appId: env.GITHUB_APP_ID,
      // PEM キーの \n エスケープを実際の改行に戻す（環境変数での一行渡しに対応）
      privateKey: env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    },
    policy: {
      allowedRepos: parseAllowedRepos(env.ALLOWED_REPOS),
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

function parseAllowedRepos(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
