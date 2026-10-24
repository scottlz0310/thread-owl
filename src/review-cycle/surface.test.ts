import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadInternalSurfaceConfig } from "./config.js";
import { startInternalSurface } from "./surface.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owl-surface-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("台帳のファイルを作成し、内部パス以外は処理せず、停止で台帳を閉じる", async () => {
  const ledgerPath = join(dir, "ledger.sqlite");
  const config = loadInternalSurfaceConfig(
    {
      THREAD_OWL_LEDGER_PATH: ledgerPath,
      THREAD_OWL_INTERNAL_PROXY_SECRET: "proxy-secret-0123456789",
      THREAD_OWL_SERVICE_ACL: JSON.stringify({
        services: { s: { actions: ["accept"], repos: ["org/*"] } },
      }),
    },
    "/mcp",
  );
  if (!config) throw new Error("setup");
  const surface = startInternalSurface(
    config,
    { getClient: vi.fn(), allowedRepos: [], allowedAuthors: [] },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    "0.0.0-test",
  );

  const res = { writeHead: vi.fn(), end: vi.fn() };
  await expect(
    surface.handle({ url: "/elsewhere", headers: {} } as never, res as never),
  ).resolves.toBe(false);
  expect(res.writeHead).not.toHaveBeenCalled();

  await surface.close();
  const { existsSync } = await import("node:fs");
  expect(existsSync(ledgerPath)).toBe(true);
});
