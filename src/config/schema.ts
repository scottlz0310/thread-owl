import { z } from "zod";

export const appConfigSchema = z.object({
  appSlug: z.string().min(1).default("thread-owl"),
  github: z.object({
    appId: z.string().min(1, "GITHUB_APP_ID is required"),
    privateKey: z
      .string({
        error:
          "GitHub App private key is required. Set GITHUB_APP_PRIVATE_KEY_FILE, GITHUB_APP_PRIVATE_KEY_B64, or GITHUB_APP_PRIVATE_KEY.",
      })
      .min(1, "GitHub App private key is empty. Check the file path or secret contents."),
    webhookSecret: z.string().min(1).optional(),
  }),
  policy: z.object({
    // 形式検証・正規化は parseAllowlist（policy/allowlist.ts）に一元化している
    allowedRepos: z.array(z.string()),
  }),
  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().min(1).default("127.0.0.1"),
    mcpHttpPath: z
      .string()
      .min(1)
      .startsWith("/", "MCP_HTTP_PATH must start with '/'")
      .default("/mcp"),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
