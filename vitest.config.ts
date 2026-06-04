import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // エントリポイントは起動時の副作用のみのため対象外
      exclude: ["src/index.ts"],
    },
  },
});
