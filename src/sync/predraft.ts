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
import { ingestTiers } from "../tiers/borischen";
import { tierTableEmpty } from "../db/tiers";
import { computeSignals } from "../signals/compute";
import { signalsTableEmpty } from "../db/signals";
import { currentSeason } from "../espn/leagueRef";
import { sessionsNeedingAttention } from "../db/draft";
import { sweepAction } from "../draft/restore";
import { sessionStub } from "../draft/session";

export async function scanPreDraftWindow(env: Env, now: Date): Promise<number> {
  const due = await findPreDraftWindowConnections(env.DB, now);
  for (const { connection } of due) {
    await refreshConnection(env, connection, now, { force: true });
  }
  if (due.length > 0) logInfo(`pre-draft scan refreshed ${due.length} league(s)`);
  return due.length;
}

/**
 * 005 T042 — restore draft sessions that died with no client attached.
 *
 * This is the half of Constitution V that does not depend on anyone watching.
 * A deploy restarts every Durable Object, and the owner may be looking at ESPN
 * rather than Draft Genie when it happens — the tap keeps relaying into the
 * log, the log keeps accepting, and nothing wakes the session up. A nudge is
 * cheap and idempotent: a healthy session finds its cursor current and commits
 * nothing.
 */
export async function sweepDraftSessions(env: Env, now: Date): Promise<number> {
  const rows = await sessionsNeedingAttention(env.DB);
  let acted = 0;
  for (const row of rows) {
    const action = sweepAction(row, now.getTime());
    if (action.kind === "skip") continue;
    const stub = sessionStub(env, row.connection_id, row.season);
    try {
      if (action.kind === "abort") {
        await stub.abort();
        await env.DB.prepare(
          `UPDATE draft_sessions SET status = 'aborted', last_error = ?, updated_at = ? WHERE connection_id = ?`,
        )
          .bind(action.why, now.toISOString(), row.connection_id)
          .run();
      } else {
        await stub.nudge();
      }
      acted++;
    } catch (e) {
      // One bad session must never stop the sweep for the others.
      logInfo(`draft sweep skipped ${row.connection_id}: ${(e as Error).message}`);
    }
  }
  if (acted > 0) logInfo(`draft sweep touched ${acted} session(s)`);
  return acted;
}

export async function runScheduledMaintenance(env: Env, now: Date): Promise<void> {
  await scanPreDraftWindow(env, now);
  await sweepDraftSessions(env, now);

  const season = currentSeason(now);
  const serving = await getServingSet(env.DB, season);
  const windows = await findPreDraftWindowConnections(env.DB, now);
  const draftTimes = windows.map(({ snapshot }) => snapshot.draft_at);

  let refreshed = false;
  if (windows.length > 0 && dueForDraftDayTopUp(draftTimes, serving?.fetched_at ?? null, now)) {
    logInfo("projection draft-day top-up triggered");
    await ingestProjections(env, season, "draft_day", now);
    refreshed = true;
  } else if (isStale(serving?.fetched_at ?? null, now)) {
    await ingestProjections(env, season, "scheduled", now);
    refreshed = true;
  }

  // Tiers ride the same cadence events; failures never block (003 FR-002).
  if (refreshed || (await tierTableEmpty(env.DB))) {
    await ingestTiers(env, now);
  }

  // Signals recompute in lockstep with projections (004 FR-007/FR-008).
  if (refreshed || (await signalsTableEmpty(env.DB))) {
    await computeSignals(env, now);
  }

  await pruneSets(env.DB, season, now);
}
