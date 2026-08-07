// 013 — THE reset path. One implementation, reached three ways.
//
// A session's state lives in TWO places: the Durable Object holds the picks,
// the cursor and the log floor; D1 holds the row the diagnostic surface and the
// liveness check read. Clearing one and not the other leaves them disagreeing,
// and the disagreement is invisible from whichever side you happen to look at.
//
// That mistake has now been made twice in this codebase, in opposite
// directions:
//
//   * the manual reset (011 T044) cleared BOTH, correctly;
//   * the observed-reset void (011 T051) cleared only D1 — so after ESPN
//     reported a real reset, every session read `idle` while the objects went
//     on serving the previous draft's 72 picks. Which is exactly what a manager
//     saw on 2026-08-07 after resetting the draft and syncing.
//
// T051 asked for "one reset path reached two ways" and got a second path
// instead. This is that one path. Callers do not get to choose half of it.

import type { Env } from "../env";
import { resetSession } from "../db/draft";
import { listConnectionsForLeague } from "../db/leagues";
import { sessionStub } from "./session";

/**
 * Clear one manager's draft, in both stores.
 *
 * ORDER IS LOAD-BEARING. The object goes first: if the row were cleared first
 * and the object call then failed, the session would report `idle` while still
 * holding the old draft — the precise shape being fixed here, reintroduced by
 * the fix. Failing the other way round leaves a cleared object and a stale row,
 * which the next arming corrects.
 *
 * Keeps the connection, the scope, the preferred list, the settings and every
 * retained frame. `reset()` is not `shutdown()` — it never sets `closed`, so
 * the session arms again.
 */
export async function resetOneSession(
  env: Env,
  connectionId: string,
  season: number,
  now: Date,
): Promise<void> {
  await sessionStub(env, connectionId, season).reset();
  await resetSession(env.DB, connectionId, now);
}

/**
 * 011 FR-031b — clear EVERY manager's draft for a league.
 *
 * Not only the one whose sync observed the reset. Under fan-out they were all
 * fed the same frames, so leaving the others holding the old draft is the
 * contamination this feature exists to end, arriving by a different door.
 *
 * Each manager is wrapped separately: one unreachable object must not stop the
 * rest being cleared. A session that fails here still has its D1 row cleared by
 * `clearEspnCompletionMemory`, and the next arming re-reads it.
 */
export async function resetLeagueSessions(
  env: Env,
  espnLeagueId: string,
  season: number,
  now: Date,
): Promise<string[]> {
  const audience = await listConnectionsForLeague(env.DB, espnLeagueId, season);
  const cleared: string[] = [];
  for (const row of audience) {
    try {
      await resetOneSession(env, row.id, season, now);
      cleared.push(row.id);
    } catch {
      /* the next arming, or the cron sweep, will correct this one */
    }
  }
  return cleared;
}
