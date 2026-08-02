// Pre-draft window scan, driven by the 5-minute cron (FR-019, research.md §8):
// every connection whose draft is inside [now−15 m, now+75 m] and not complete
// gets a forced refresh, capturing the late-published draft order (SC-004).

import type { Env } from "../env";
import { findPreDraftWindowConnections } from "../db/leagues";
import { refreshConnection } from "./refresh";
import { logInfo } from "../api/logging";

export async function scanPreDraftWindow(env: Env, now: Date): Promise<number> {
  const due = await findPreDraftWindowConnections(env.DB, now);
  for (const { connection } of due) {
    await refreshConnection(env, connection, now, { force: true });
  }
  if (due.length > 0) logInfo(`pre-draft scan refreshed ${due.length} league(s)`);
  return due.length;
}
