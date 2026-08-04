// 010 T013 — two projects in one run.
//
// The Worker suite needs @cloudflare/vitest-pool-workers (D1, bindings,
// migrations). The tap's pure modules are browser-targeted and cannot run in
// that pool at all, so they get a plain node project. Splitting is required,
// not preferred.
//
// The workers project keeps its own file (vitest.workers.config.ts) because
// defineWorkersConfig builds a complete config; referencing it by path here is
// what lets both run under a single `npm test`.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./vitest.workers.config.ts",
      {
        test: {
          name: "tap",
          environment: "node",
          include: ["tests/tap/**/*.test.ts"],
        },
      },
    ],
  },
});
