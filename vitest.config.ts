import { defineConfig } from "vitest/config";
import path from "path";

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
    include: ["tests/**/*.test.ts"],
    // PLAN.md §34.2 — the credential-gated, real-provider smoke suite
    // (tests/integration/**) is structurally excluded from the default
    // suite `npm run test`/CI run: it makes real network calls to a real
    // AI provider and must never run automatically. Run it explicitly via
    // `npm run test:smoke:anthropic` (vitest.integration.config.ts), never
    // through this config.
    exclude: ["**/node_modules/**", "**/.git/**", "tests/integration/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/app/api/**", "src/proxy.ts"],
      exclude: [
        "src/generated/**",
        "src/components/**",
        "src/app/(dashboard)/**",
        "src/app/(auth)/**",
      ],
    },
    // PLAN.md §46.6 — bumped from 10000: the real-ESLint-instance suites
    // (tests/security/{module-boundary,raw-prisma}-lint.test.ts) each
    // construct a fresh ESLint instance per test, and the flat config's
    // load cost grows with the codebase's file count; under full-suite
    // parallelism this phase's growth pushed that suite past the old
    // 10s ceiling intermittently even though each test's own work is
    // still well under a second — not a hang, a marginal ceiling.
    testTimeout: 20000,
  },
});
