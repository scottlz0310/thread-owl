import { z } from "zod";

export const appConfigSchema = z.object({
  github: z.object({
    appId: z.string().min(1, "GITHUB_APP_ID is required"),
    privateKey: z.string().min(1, "GITHUB_APP_PRIVATE_KEY is required"),
    webhookSecret: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  }),
  policy: z.object({
    allowedRepos: z.array(
      z.string().regex(/^[^/]+\/[^/]+$/, "allowedRepos entries must be in 'owner/repo' format"),
    ),
  }),
  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().default("127.0.0.1"),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
