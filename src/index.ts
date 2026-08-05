// Draft Genie Worker entry: JSON API + SPA assets (via platform config) and
// the 5-minute pre-draft sync cron (FR-019).

import { createApp } from "./api/app";
import { now, type Env } from "./env";
import { runScheduledMaintenance } from "./sync/predraft";

// 005: the Durable Object class named in wrangler.jsonc must be exported here,
// or wrangler refuses to deploy the Worker at all.
export { DraftSession } from "./draft/session";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledMaintenance(env, now(env)));
  },
} satisfies ExportedHandler<Env>;
