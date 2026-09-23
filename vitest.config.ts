import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // These are integration tests that publish content, walk whole ticks and start child
    // processes, so a run under load needs more than the default budget.
    testTimeout: 30_000,
    // Leave headroom on the machine: doubling the worker count only adds contention.
    maxWorkers: 8,
  },
});
