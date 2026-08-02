// Scheduled maintenance, driven by the 5-minute cron.
// 001: pre-draft league re-sync inside [now−15 m, now+75 m] (001 FR-019).
// 002: projection freshness — draft-day top-up, cadence refresh, pruning
// (002 FR-015/FR-018, SC-007). Order matters: leagues re-sync first so a
// just-published draft time can inform the top-up check on the same tick.

import type { Env } from "../env";
import { findPreDraftWindowConnections } from "../db/leagues";
import { refreshConnection } from "./refresh";
import { logInfo } from "../api/logging";
import { dueForDraftDayTopUp, isStale } from "../projections/freshness";
import { ingestProjections } from "../projections/ingest";
import { getServingSet, pruneSets } from "../db/projections";
import { currentSeason } from "../espn/leagueRef";

export async function scanPreDraftWindow(env: Env, now: Date): Promise<number> {
  const due = await findPreDraftWindowConnections(env.DB, now);
  for (const { connection } of due) {
    await refreshConnection(env, connection, now, { force: true });
  }
  if (due.length > 0) logInfo(`pre-draft scan refreshed ${due.length} league(s)`);
  return due.length;
}

export async function runScheduledMaintenance(env: Env, now: Date): Promise<void> {
  await scanPreDraftWindow(env, now);

  const season = currentSeason(now);
  const serving = await getServingSet(env.DB, season);
  const windows = await findPreDraftWindowConnections(env.DB, now);
  const draftTimes = windows.map(({ snapshot }) => snapshot.draft_at);

  if (windows.length > 0 && dueForDraftDayTopUp(draftTimes, serving?.fetched_at ?? null, now)) {
    logInfo("projection draft-day top-up triggered");
    await ingestProjections(env, season, "draft_day", now);
  } else if (isStale(serving?.fetched_at ?? null, now)) {
    await ingestProjections(env, season, "scheduled", now);
  }

  await pruneSets(env.DB, season, now);
}
