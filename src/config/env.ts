// Runtime environment configuration
// TODO: validate with zod in Phase 1

export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ALLOWED_REPOS: string;
  PORT: number;
  LOG_LEVEL: string;
}

export function loadEnv(): Env {
  throw new Error("not implemented");
}
