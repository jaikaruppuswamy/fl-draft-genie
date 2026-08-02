// Draft Genie Worker entry: JSON API + SPA assets (via platform config) and
// the 5-minute pre-draft sync cron (FR-019).

import { createApp } from "./api/app";
import { now, type Env } from "./env";
import { scanPreDraftWindow } from "./sync/predraft";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scanPreDraftWindow(env, now(env)));
  },
} satisfies ExportedHandler<Env>;
