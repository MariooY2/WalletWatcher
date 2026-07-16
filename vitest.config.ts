import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Tests are fully offline (no RPC); keep them fast and deterministic.
    testTimeout: 10_000,
  },
});
