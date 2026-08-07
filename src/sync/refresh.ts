// Re-sync of an existing connection (FR-018/FR-019/FR-020).
// Failure semantics: the previous snapshot is never discarded; only the
// connection's last_sync_status flips. ESPN 401/403 additionally marks the
// account's credentials failing (FR-008).

import type { Env } from "../env";
import { createEspnClient } from "../espn/client";
import { EspnError, type EspnLeagueResponse } from "../espn/types";
import { parseLeague } from "../espn/parsers";
import { setCredentialStatus } from "../db/credentials";
import {
  getSnapshot,
  listConnectionsForLeague,
  recordSyncFailure,
  recordSyncSuccess,
  type ConnectionRow,
} from "../db/leagues";
import { clearEspnCompletionMemory, getSession, rememberEspnCompletion, setResetSuspicion } from "../db/draft";
import { resetLeagueSessions } from "../draft/reset";
import { isLiveDraft } from "../draft/liveness";
import { classifyReset } from "./resetObserved";
import { loadDecryptedCredentials } from "./connect";
import { logError, logInfo } from "../api/logging";

/** Politeness floor between full syncs of one league (research.md §7). */
const MIN_SYNC_INTERVAL_MS = 30_000;

export type RefreshResult = "ok" | "failed" | "skipped_recent";

export async function refreshConnection(
  env: Env,
  connection: ConnectionRow,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<RefreshResult> {
  if (
    !opts.force &&
    connection.last_sync_at &&
    now.getTime() - new Date(connection.last_sync_at).getTime() < MIN_SYNC_INTERVAL_MS
  ) {
    return "skipped_recent";
  }

  const loaded = await loadDecryptedCredentials(env, connection.account_id);
  if (!loaded) {
    await recordSyncFailure(env.DB, connection.id);
    return "failed";
  }

  const client = createEspnClient(env, loaded.creds);
  try {
    const raw = await client.fetchLeague(connection.season, connection.espn_league_id, [
      "mSettings",
      "mTeam",
      "mDraftDetail",
    ]);
    // 011 US8 — BEFORE the write, because the write is what destroys the
    // evidence. `recordSyncSuccess` upserts a single snapshot row with no
    // history, so anything compared against it afterwards is racing its own
    // writer.
    await observeDraftReset(env, connection, raw, now);

    await recordSyncSuccess(env.DB, connection.id, parseLeague(raw), now);
    await setCredentialStatus(env.DB, connection.account_id, "working", now);
    logInfo(`synced league ${connection.espn_league_id} (connection ${connection.id})`);
    return "ok";
  } catch (err) {
    await recordSyncFailure(env.DB, connection.id);
    if (err instanceof EspnError && err.code === "espn_rejected") {
      await setCredentialStatus(env.DB, connection.account_id, "failing", now);
    }
    logError(`sync failed for league ${connection.espn_league_id}`, err);
    return "failed";
  }
}

/**
 * 011 T049–T054 — notice that ESPN has un-completed a draft, and void it.
 *
 * Called between the fetch and the snapshot write. The decision itself lives in
 * `src/sync/resetObserved.ts` where it can be tested; this is the wiring plus
 * the two facts the classifier cannot read for itself — whether any session in
 * the league is live, and whether one is still waiting to be archived.
 */
async function observeDraftReset(
  env: Env,
  connection: ConnectionRow,
  raw: EspnLeagueResponse,
  now: Date,
): Promise<void> {
  const dd = (raw as { draftDetail?: unknown }).draftDetail;
  const snapshot = await getSnapshot(env.DB, connection.id);

  // Remember a completion the moment ESPN reports one. This is what makes the
  // later change observable at all, and it is deliberately monotonic.
  const reportsComplete =
    dd !== null && typeof dd === "object" && (dd as { drafted?: unknown }).drafted === true;
  if (reportsComplete) {
    await rememberEspnCompletion(env.DB, connection.id, now);
    if (snapshot?.espn_reset_suspected_at) await setResetSuspicion(env.DB, connection.id, null);
    return;
  }

  // Nothing to notice unless ESPN has previously told us this draft finished.
  if (!snapshot?.espn_draft_completed_at) return;

  // The two facts the classifier is handed rather than reading. Both are about
  // the league, not this connection: under fan-out a live session belonging to
  // any manager makes the whole league untouchable.
  const audience = await listConnectionsForLeague(env.DB, connection.espn_league_id, connection.season);
  let anyLive = false;
  let awaitingArchive = false;
  for (const row of audience) {
    const session = await getSession(env.DB, row.id);
    if (!session) continue;
    if (session.completed_at !== null && session.archived_at === null) awaitingArchive = true;
    if (
      isLiveDraft({
        status: session.status,
        completedAt: session.completed_at,
        lastHeartbeatAt: session.last_heartbeat_at ? Date.parse(session.last_heartbeat_at) : null,
        hidden: session.heartbeat_hidden === 1,
        now: now.getTime(),
      })
    ) {
      anyLive = true;
    }
  }

  const outcome = classifyReset({
    espnCompletedAt: snapshot.espn_draft_completed_at,
    suspectedAt: snapshot.espn_reset_suspected_at ?? null,
    draftDetail: dd,
    identityMatches:
      Number((raw as { id?: unknown }).id) === Number(connection.espn_league_id) &&
      Number((raw as { seasonId?: unknown }).seasonId) === Number(connection.season),
    anyLive,
    awaitingArchive,
    supportedDraftType: (() => {
      try {
        return (JSON.parse(snapshot.draft_json) as { supported?: boolean }).supported === true;
      } catch {
        return false;
      }
    })(),
    now: now.toISOString(),
  });

  if (outcome.kind === "ignore") {
    // A non-qualifying observation clears any standing suspicion, so two
    // unrelated oddities a week apart cannot add up to a void.
    if (snapshot.espn_reset_suspected_at) await setResetSuspicion(env.DB, connection.id, null);
    return;
  }

  if (outcome.kind === "suspect") {
    await setResetSuspicion(env.DB, connection.id, now);
    logInfo(
      `reset suspected for league ${connection.espn_league_id} season ${connection.season}; awaiting a second observation`,
    );
    return;
  }

  // BOTH STORES, through the one reset path. Clearing only the rows is what
  // left every room serving the previous draft's picks after a real reset.
  const voided = await resetLeagueSessions(env, connection.espn_league_id, connection.season, now);
  await clearEspnCompletionMemory(env.DB, connection.espn_league_id, connection.season);
  // FR-031e: the reason AND the observation that triggered it. Counts only —
  // which manager's sync noticed is not part of the record.
  logInfo(
    `voided ${voided.length} session(s) for league ${connection.espn_league_id} season ${connection.season}: ` +
      `${outcome.reason} (${outcome.observedFilled}/${outcome.rows} picks filled)`,
  );
}
