// 005 T048/T049/T050 — archive a completed draft, verified against ESPN.
//
// WHY THIS RUNS IN THE CRON AND NOT IN THE DURABLE OBJECT: the oracle needs an
// authenticated ESPN read, and FR-024a forbids the session ever holding a
// credential. Putting the fetch in the object would mean handing it the ESPN
// cookie pair — the one thing `no-secrets.test.ts` asserts can never be there.
// The sweep already loads and decrypts credentials for 001's refresh, so the
// capability lives where it already belongs.
//
// It also means archiving does not sit on the draft's critical path. The draft
// finishing and the draft being archived are separate concerns, and a failed
// ESPN read must not be able to lose a completed draft: the session's state is
// already durable, and the row stays unarchived until a later sweep succeeds.
//
// WHAT THE ORACLE IS FOR: ESPN's post-completion flush is the one view Gate 0
// proved reliable, and it is derived WITHOUT the tap — so it can catch a
// systematic error that self-consistency never could. In 010 it disproved the
// field-3 reading (5/70) and confirmed the ledger offsets (31/31). Divergence
// is RECORDED, never silently resolved.

import type { Env } from "../env";
import { createEspnClient } from "../espn/client";
import { parseCompletedDraft } from "../espn/parsers";
import { loadDecryptedCredentials } from "../sync/connect";
import { getConnectionById, getSnapshot } from "../db/leagues";
import { markArchived, sessionsAwaitingArchive, writeArchive } from "../db/draft";
import { compareToOracle, isClean, reconciledPicks, type Divergence } from "./oracle";
import { sessionStub } from "./session";
import { logError, logInfo } from "../api/logging";
import type { Pick } from "./reconcile";

export interface ArchiveOutcome {
  connectionId: string;
  archived: boolean;
  divergence: Divergence | null;
  why?: string;
}

/**
 * Archive every completed-but-unarchived draft.
 *
 * Returns one outcome per session so the caller can log meaningfully; a single
 * failure never stops the others.
 */
export async function archiveCompletedDrafts(env: Env, now: Date): Promise<ArchiveOutcome[]> {
  const rows = await sessionsAwaitingArchive(env.DB);
  const out: ArchiveOutcome[] = [];

  for (const row of rows) {
    try {
      out.push(await archiveOne(env, row.connection_id, row.account_id, row.season, now));
    } catch (e) {
      logError(`draft archive failed for ${row.connection_id}`, e as Error);
      // Deliberately NOT marked archived: the draft stays in the queue and a
      // later sweep retries. Losing a completed draft is the one outcome worth
      // retrying indefinitely for.
      out.push({ connectionId: row.connection_id, archived: false, divergence: null, why: "error" });
    }
  }

  const done = out.filter((o) => o.archived).length;
  if (done > 0) logInfo(`archived ${done} completed draft(s)`);
  return out;
}

async function archiveOne(
  env: Env,
  connectionId: string,
  accountId: string,
  season: number,
  now: Date,
): Promise<ArchiveOutcome> {
  const snapshot = await runSnapshot(env, connectionId, season);
  if (!snapshot || snapshot.picks.length === 0) {
    // Nothing to archive. Do NOT mark it archived — a session that reported
    // complete with no picks is a bug worth seeing again, not one to bury.
    return { connectionId, archived: false, divergence: null, why: "no_picks" };
  }

  const connection = await getConnectionById(env.DB, accountId, connectionId);
  if (!connection) return { connectionId, archived: false, divergence: null, why: "connection_gone" };

  const leagueSnapshot = await getSnapshot(env.DB, connectionId);
  const teamCount = leagueSnapshot?.team_count ?? 0;

  // --- the oracle ---------------------------------------------------------
  let picks: Pick[] = snapshot.picks;
  let divergence: Divergence | null = null;

  const creds = await loadDecryptedCredentials(env, accountId);
  if (creds) {
    try {
      const raw = await createEspnClient(env, creds.creds).fetchLeague(season, connection.espn_league_id, [
        "mDraftDetail",
      ]);
      const espn = parseCompletedDraft(raw);
      if (espn.length > 0) {
        divergence = compareToOracle(picks, espn);
        if (!isClean(divergence)) {
          logInfo(
            `draft ${connectionId} diverges from ESPN: ${divergence.missing.length} missing, ` +
              `${divergence.extra.length} extra, ${divergence.mismatched.length} mismatched`,
          );
          // ESPN's record is the league's book of record once the draft is
          // over; ours is a reconstruction from a live stream. Adopt theirs,
          // but keep the difference on the row so a systematic tap problem
          // surfaces instead of being papered over.
          picks = reconciledPicks(picks, espn) ?? picks;
        }
      }
    } catch (e) {
      // A failed ESPN read must not block the archive. The draft is real and
      // worth keeping unverified; `oracle_checked_at` stays null to say so.
      logError(`oracle read failed for ${connectionId}; archiving unverified`, e as Error);
    }
  }

  await writeArchive(
    env.DB,
    {
      accountId,
      connectionId,
      espnLeagueId: connection.espn_league_id,
      season,
      leagueName: leagueSnapshot?.league_name ?? null,
      myTeamId: connection.my_team_id,
      teamCount,
      roundCount: teamCount > 0 ? Math.ceil(picks.length / teamCount) : 0,
      order: snapshot.order ?? [],
      teams: [],
      state: { ...snapshotToState(snapshot), picks },
      oracleDivergence: divergence && !isClean(divergence) ? divergence : null,
      startedAt: picks[0]?.observedAt ?? null,
      completedAt: now.toISOString(),
    },
    now,
  );
  await markArchived(env.DB, connectionId, now);

  return { connectionId, archived: true, divergence };
}

interface SessionView {
  picks: Pick[];
  revision: number;
  order?: number[];
  totalPicks: number;
}

async function runSnapshot(env: Env, connectionId: string, season: number): Promise<SessionView | null> {
  const snap = await sessionStub(env, connectionId, season).snapshot();
  if (!snap) return null;
  return { picks: snap.picks, revision: snap.revision, totalPicks: snap.totalPicks };
}

/** The archive writer wants a DraftState shape; only these fields are read. */
function snapshotToState(v: SessionView) {
  return {
    revision: v.revision,
    seq: 0,
    order: v.order ?? [],
    myTeamId: null,
    totalPicks: v.totalPicks,
    confirmed: [],
    pending: [],
    picks: v.picks,
    deckFired: {},
    clockFired: {},
    complete: true,
  };
}
