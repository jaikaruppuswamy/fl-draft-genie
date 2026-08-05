// 010 T013 / 005 T003 — three projects in one run.
//
// The Worker suite needs @cloudflare/vitest-pool-workers (D1, bindings,
// migrations). The tap's pure modules are browser-targeted and cannot run in
// that pool at all, so they get a plain node project. Splitting is required,
// not preferred.
//
// 005's tests/draft/** project runs in a SEPARATE PROCESS — see package.json's
// `test` script — because it needs isolatedStorage: false while this one needs
// it on, and the pool's storage stack cannot host both in one runtime: doing so
// aborted runs intermittently with "Isolated storage failed". Sharing a process
// was the problem, so they no longer share one.
//
// It needs isolatedStorage: false because
// WebSockets in Durable Objects are unsupported with per-file storage
// isolation. Turning that off globally would make every existing D1 test share
// state, so it is scoped to its own project — and vitest.workers.config.ts
// carries a matching exclude, or these files would run in both.
//
// Each workers project keeps its own file because defineWorkersConfig builds a
// complete config; referencing them by path here is what lets all three run
// under a single `npm test`. A suite that is not in `npm test` is not a suite.

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
