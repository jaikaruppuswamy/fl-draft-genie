// Scheduled maintenance, driven by the 5-minute cron.
// 001: pre-draft league re-sync inside [now−15 m, now+75 m] (001 FR-019).
// 002: projection freshness — draft-day top-up, cadence refresh, pruning
// (002 FR-015/FR-018, SC-007). Order matters: leagues re-sync first so a
// just-published draft time can inform the top-up check on the same tick.

import type { Env } from "../env";
import { findPostDraftWatchConnections, findPreDraftWindowConnections } from "../db/leagues";
import { refreshConnection } from "./refresh";
import { logError, logInfo } from "../api/logging";
import { dueForDraftDayTopUp, isStale } from "../projections/freshness";
import { ingestProjections } from "../projections/ingest";
import { getServingSet, pruneSets } from "../db/projections";
import { computeSignals } from "../signals/compute";
import { signalsTableEmpty } from "../db/signals";
import { currentSeason } from "../espn/leagueRef";
import { sessionsNeedingAttention } from "../db/draft";
import { sweepAction } from "../draft/restore";
import { sessionStub } from "../draft/session";
import { archiveCompletedDrafts } from "../draft/archiveRun";

export async function scanPreDraftWindow(env: Env, now: Date): Promise<number> {
  const due = await findPreDraftWindowConnections(env.DB, now);
  for (const { connection } of due) {
    await refreshConnection(env, connection, now, { force: true });
  }
  if (due.length > 0) logInfo(`pre-draft scan refreshed ${due.length} league(s)`);
  return due.length;
}

/**
 * 011 T055 (SC-009a) — keep reading a league AFTER its draft finished, so a
 * reset in ESPN is noticed with no action by the owner.
 *
 * The pre-draft scan cannot do it. A reset clears ESPN's draft date, and a
 * completed league is excluded by that AND by its completed flag — an exclusion
 * that never lifts by itself. Without this stage, "the next sync" means the
 * owner opening the app, and SC-009a is unsatisfiable rather than merely unmet.
 *
 * The refresh itself does the noticing; this only decides who gets read. Costs
 * roughly four extra ESPN reads a day per recently-completed league, bounded by
 * a 30-day window and a page per tick.
 */
export async function scanPostDraftWatch(env: Env, now: Date): Promise<number> {
  const due = await findPostDraftWatchConnections(env.DB, now);
  for (const { connection } of due) {
    await refreshConnection(env, connection, now, { force: true });
  }
  if (due.length > 0) logInfo(`post-draft watch refreshed ${due.length} league(s)`);
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

/**
 * Run one maintenance stage, isolating its failure from the others.
 *
 * These jobs are INDEPENDENT: a projection ingest failing has nothing to do
 * with whether a completed draft gets archived. Running them in a bare
 * sequence meant the first throw cancelled everything after it — so an ESPN
 * hiccup during projections could leave a finished draft unarchived
 * indefinitely. A test caught this only because it exercised the real
 * scheduled entry point rather than calling the archive function directly.
 */
async function stage(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    logError(`scheduled stage "${name}" failed; continuing`, e as Error);
  }
}

export async function runScheduledMaintenance(env: Env, now: Date): Promise<void> {
  await stage("pre-draft scan", () => scanPreDraftWindow(env, now));
  // Its own stage: a failure here must not cancel the sweep below, and a
  // reset noticed late is far better than a session sweep that did not run.
  await stage("post-draft watch", () => scanPostDraftWatch(env, now));
  await stage("draft session sweep", () => sweepDraftSessions(env, now));

  // Archiving runs in the cron rather than the Durable Object because the
  // oracle needs an authenticated ESPN read, and FR-024a forbids the session
  // holding a credential. It runs EARLY and in its own stage: retaining a
  // finished draft matters more than any of the refresh work below, and must
  // not be cancelled by it.
  await stage("draft archive", () => archiveCompletedDrafts(env, now));

  await stage("projections and signals", () => refreshDerivedData(env, now));
}

async function refreshDerivedData(env: Env, now: Date): Promise<void> {
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


  // Signals recompute in lockstep with projections (004 FR-007/FR-008).
  if (refreshed || (await signalsTableEmpty(env.DB))) {
    await computeSignals(env, now);
  }

  await pruneSets(env.DB, season, now);
}
