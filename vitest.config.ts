import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["exports/**", "node_modules/**", "**/release-stage*/**"],
    // several tests do real parsing, processing and workbook writing; the 5 s
    // default flakes on a loaded machine even though the work itself is fast
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
