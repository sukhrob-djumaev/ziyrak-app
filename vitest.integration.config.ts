import { defineConfig } from "vitest/config";
import path from "path";

/**
 * PLAN.md §34.2 — a deliberately separate config from vitest.config.ts,
 * only for the credential-gated real-provider smoke suite
 * (tests/integration/**). vitest.config.ts (what `npm run test`/CI use)
 * explicitly excludes tests/integration/** — this config is the only way
 * to run it, invoked manually via `npm run test:smoke:anthropic`, never
 * automatically.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30000,
  },
});
