// Application configuration schema
// TODO: define with zod in Phase 1

export interface AppConfig {
  github: {
    appId: string;
    privateKey: string;
    webhookSecret: string;
  };
  policy: {
    allowedRepos: string[];
  };
  server: {
    port: number;
  };
  logging: {
    level: string;
  };
}

export function parseConfig(_env: Record<string, string | undefined>): AppConfig {
  throw new Error("not implemented");
}
