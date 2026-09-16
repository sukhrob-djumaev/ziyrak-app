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
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/app/api/**", "src/middleware.ts"],
      exclude: [
        "src/generated/**",
        "src/components/**",
        "src/app/(dashboard)/**",
        "src/app/(auth)/**",
      ],
    },
    testTimeout: 10000,
  },
});
