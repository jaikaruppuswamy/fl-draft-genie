// 005 T003 — the third Vitest project.
//
// WHY IT EXISTS: WebSockets in Durable Objects are unsupported with per-file
// storage isolation, which the main workers suite depends on. Turning isolation
// off globally would make every existing D1 test share state; scoping it to
// tests/draft/** keeps that blast radius at zero.
//
// vitest.workers.config.ts carries a matching EXCLUDE for tests/draft/**. Its
// include glob is `tests/**/*.test.ts`, so without that exclude these tests
// would also be collected there and fail for reasons unrelated to the code.

import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      // Distinct from the workers project's name, or vitest refuses to load
      // both: projects must be uniquely named.
      name: "draft",
      setupFiles: ["./tests/apply-migrations.ts"],
      include: ["tests/draft/**/*.test.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
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
