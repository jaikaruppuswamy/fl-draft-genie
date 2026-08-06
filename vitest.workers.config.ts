import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
      include: ["tests/**/*.test.ts"],
      // tests/tap/** and tests/room/** belong to the node project — see
      // vitest.config.ts. Without this exclude the workers pool also collects
      // them and they fail there. 007's room tests are pure by construction
      // (the reducer takes `at` as a parameter and touches no platform), which
      // is exactly why they can live in the plain node project.
      //
      // tests/draft/** belongs to vitest.draft.config.ts, which runs with
      // isolatedStorage: false because WebSockets in Durable Objects are
      // unsupported with per-file storage isolation. This include glob is
      // `tests/**/*.test.ts`, so without the exclude every DO test ALSO runs
      // here, under the isolation that cannot support it.
      //
      // tests/lab/** is 008's, and it is the same situation as tests/room/**:
      // the lab core is pure by construction (no D1, no clock, no fetch), it
      // reads committed fixtures, and it has no business in a Worker runtime.
      // `/speckit-analyze` caught its absence here BEFORE it was written —
      // adding a node project without the matching exclude is precisely the
      // double-collection this list already exists to prevent.
      exclude: ["tests/tap/**", "tests/draft/**", "tests/room/**", "tests/lab/**"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Test-only secrets (32 bytes base64 for the AES key).
              SESSION_SECRET: "dGVzdC1zZXNzaW9uLXNlY3JldC10ZXN0LXNlc3Npb24=",
              CREDENTIAL_KEY: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
              EMAIL_PROVIDER: "console",
              APP_BASE_URL: "http://localhost:8787",
            },
          },
        },
      },
    },
  };
});
