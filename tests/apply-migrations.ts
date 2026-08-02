import { applyD1Migrations, env } from "cloudflare:test";

// Migrations are provided by vitest.config.ts as the TEST_MIGRATIONS binding.
await applyD1Migrations(
  (env as { DB: D1Database }).DB,
  (env as unknown as { TEST_MIGRATIONS: never }).TEST_MIGRATIONS,
);
