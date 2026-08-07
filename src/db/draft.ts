// 005 T018 — draft_sessions header and the permanent archive.
//
// The DO's SQLite storage is the LIVE authority; this file owns only what D1
// must know: the cron work-list, the liveness the diagnostic surface reads, and
// the archive that outlives everything.
//
// THE CASCADE SPLIT IS THE POINT (research §5, FR-013). `draft_sessions`
// cascades from `league_connections` — disconnect a league and its session
// should stop. The archive does NOT: it keys on `account_id` and cascades from
// `accounts` only, because an owner who disconnects a league in March has not
// asked to erase their August draft.

import type { DraftState } from "../draft/reconcile";
import type { SessionStatus } from "../draft/schedule";

export interface DraftSessionRow {
  connection_id: string;
  account_id: string;
  season: number;
  status: SessionStatus;
  armed_at: string | null;
  scheduled_at: string | null;
  last_heartbeat_at: string | null;
  heartbeat_hidden: number;
  tap_state: string | null;
  tap_version: string | null;
  feed_received_at: string | null;
  feed_id: string | null;
  last_error: string | null;
  consecutive_errors: number;
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Create the session row on first contact, or refresh it.
 *
 * FR-007g: the first frame from a tap — heartbeat included — arms the session.
 * `armed_at` is set once and never overwritten, so a reconnect does not reset
 * the clock the armed deadline is measured from.
 */
export async function upsertSession(
  db: D1Database,
  s: {
    connectionId: string;
    accountId: string;
    season: number;
    status: SessionStatus;
    scheduledAt?: string | null;
  },
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  await db
    .prepare(
      `INSERT INTO draft_sessions
         (connection_id, account_id, season, status, armed_at, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET
         -- 011 T041: a COMPLETED session keeps its status when re-armed.
         --
         -- This used to write excluded.status unconditionally, which produced
         -- a session marked armed while still holding completed_at, observed
         -- live 2026-08-06. That session can NEVER reach live, because both
         -- status transitions below are guarded on completed_at IS NULL. It
         -- accepts frames and never reports a running draft.
         --
         -- Leaving it complete is the honest resolution: re-arming is not a
         -- decision to un-complete a draft. The only ways out are an explicit
         -- reset (US5) or an ESPN reset observed at sync (US8), and both clear
         -- the stamp and the status together.
         status = CASE
           WHEN draft_sessions.completed_at IS NOT NULL THEN draft_sessions.status
           ELSE excluded.status
         END,
         scheduled_at = COALESCE(excluded.scheduled_at, draft_sessions.scheduled_at),
         armed_at = COALESCE(draft_sessions.armed_at, excluded.armed_at),
         updated_at = excluded.updated_at`,
    )
    .bind(s.connectionId, s.accountId, s.season, s.status, iso, s.scheduledAt ?? null, iso, iso)
    .run();
}

/**
 * Record a heartbeat (FR-007e).
 *
 * `hidden` is stored because it decides WHICH lapse threshold applies: a
 * background tab's timers throttle to ~1/minute, and one threshold would
 * declare a healthy backgrounded tap dead. Only the tap can observe this.
 */
export async function recordHeartbeat(
  db: D1Database,
  connectionId: string,
  h: { hidden: boolean; tapState?: string | null; tapVersion?: string | null },
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  await db
    .prepare(
      `UPDATE draft_sessions
          SET last_heartbeat_at = ?, heartbeat_hidden = ?, tap_state = COALESCE(?, tap_state),
              tap_version = COALESCE(?, tap_version), updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(iso, h.hidden ? 1 : 0, h.tapState ?? null, h.tapVersion ?? null, iso, connectionId)
    .run();
}

/** Persist the feed cursor. Called only AFTER the batch is committed. */
export async function saveCursor(
  db: D1Database,
  connectionId: string,
  cursor: { receivedAt: string; id: string },
  now: Date,
): Promise<void> {
  await db
    .prepare(`UPDATE draft_sessions SET feed_received_at = ?, feed_id = ?, updated_at = ? WHERE connection_id = ?`)
    .bind(cursor.receivedAt, cursor.id, now.toISOString(), connectionId)
    .run();
}

export async function getSession(db: D1Database, connectionId: string): Promise<DraftSessionRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM draft_sessions WHERE connection_id = ?`)
      .bind(connectionId)
      .first<DraftSessionRow>()) ?? null
  );
}

/**
 * The 5-minute cron's work-list.
 *
 * Excludes terminal states and anything archived. Without the `archived_at`
 * condition the cron would resurrect a finished draft every five minutes.
 */
export async function sessionsNeedingAttention(db: D1Database): Promise<DraftSessionRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM draft_sessions
        WHERE archived_at IS NULL
          AND status NOT IN ('aborted', 'unsupported', 'complete')
        ORDER BY updated_at ASC`,
    )
    .all<DraftSessionRow>();
  return r.results ?? [];
}

export interface ArchiveInput {
  accountId: string;
  connectionId: string;
  espnLeagueId: string;
  season: number;
  leagueName: string | null;
  myTeamId: number | null;
  teamCount: number;
  roundCount: number;
  order: number[];
  teams: { teamId: number; name: string }[];
  state: DraftState;
  oracleDivergence: unknown | null;
  startedAt: string | null;
  completedAt: string;
}

/**
 * Write the permanent archive. Retained INDEFINITELY as season history
 * (ratified 2026-08-02), so 008's replay lab inherits a real corpus.
 *
 * `observed_at` is FIRST-SEEN-WINS: a cold rebuild collapses every pick onto a
 * single observation time, and overwriting would destroy the per-pick timing
 * 008 depends on.
 */
export async function writeArchive(db: D1Database, a: ArchiveInput, now: Date): Promise<string> {
  const id = crypto.randomUUID();
  const iso = now.toISOString();
  await db
    .prepare(
      `INSERT INTO draft_archives
         (id, account_id, connection_id, espn_league_id, season, league_name, format, my_team_id,
          team_count, round_count, order_json, teams_json, oracle_checked_at, oracle_divergence_json,
          revision, started_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'snake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, espn_league_id, season) DO NOTHING`,
    )
    .bind(
      id,
      a.accountId,
      a.connectionId,
      a.espnLeagueId,
      a.season,
      a.leagueName,
      a.myTeamId,
      a.teamCount,
      a.roundCount,
      JSON.stringify(a.order),
      JSON.stringify(a.teams),
      a.oracleDivergence === null ? null : iso,
      a.oracleDivergence === null ? null : JSON.stringify(a.oracleDivergence),
      a.state.revision,
      a.startedAt,
      a.completedAt,
      iso,
    )
    .run();

  const row = await db
    .prepare(`SELECT id FROM draft_archives WHERE account_id = ? AND espn_league_id = ? AND season = ?`)
    .bind(a.accountId, a.espnLeagueId, a.season)
    .first<{ id: string }>();
  const archiveId = row?.id ?? id;

  // Chunked: D1 caps the number of bound parameters per statement, and a
  // 192-pick draft would exceed it in one go.
  const CHUNK = 40;
  for (let i = 0; i < a.state.picks.length; i += CHUNK) {
    const slice = a.state.picks.slice(i, i + CHUNK);
    await db.batch(
      slice.map((p) =>
        db
          .prepare(
            `INSERT INTO draft_picks
               (archive_id, overall, round, round_pick, team_id, player_id, keeper, autodrafted, observed_at, observed_epoch)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
             ON CONFLICT (archive_id, overall) DO UPDATE SET
               team_id = excluded.team_id,
               player_id = excluded.player_id,
               -- FIRST-SEEN-WINS: never overwrite the original observation time.
               observed_at = COALESCE(draft_picks.observed_at, excluded.observed_at)`,
          )
          .bind(
            archiveId,
            p.overall,
            a.teamCount > 0 ? Math.ceil(p.overall / a.teamCount) : 0,
            a.teamCount > 0 ? ((p.overall - 1) % a.teamCount) + 1 : 0,
            p.teamId,
            p.playerId,
            p.observedAt,
            p.epoch,
          ),
      ),
    );
  }
  return archiveId;
}

/**
 * 005 T058 — write the session's LIVE status back to D1.
 *
 * The Durable Object holds the authoritative state, but D1 is what the cron
 * sweep and the diagnostic surface read. Without this the row stays `armed`
 * for the entire draft: the surface reports a stale status, and — worse —
 * `sweepAction`'s armed deadline becomes reachable against a session that is
 * actually live, because nothing ever writes `live`. The distinction exists
 * precisely to prevent that.
 *
 * Only a FORWARD transition is written. A late-arriving update must not drag a
 * completed draft back to live.
 */
export async function markSessionStatus(
  db: D1Database,
  connectionId: string,
  status: "live" | "complete",
  now: Date,
): Promise<void> {
  const iso = now.toISOString();
  if (status === "complete") {
    await db
      .prepare(
        `UPDATE draft_sessions
            SET status = 'complete', completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE connection_id = ? AND completed_at IS NULL`,
      )
      .bind(iso, iso, connectionId)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE draft_sessions SET status = 'live', updated_at = ?
        WHERE connection_id = ? AND completed_at IS NULL AND status IN ('idle', 'armed', 'not_receiving', 'degraded')`,
    )
    .bind(iso, connectionId)
    .run();
}

/** Sessions whose draft finished but which have not been archived yet. */
export async function sessionsAwaitingArchive(db: D1Database): Promise<DraftSessionRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM draft_sessions
        WHERE completed_at IS NOT NULL AND archived_at IS NULL
        ORDER BY completed_at ASC`,
    )
    .all<DraftSessionRow>();
  return r.results ?? [];
}

export async function markArchived(db: D1Database, connectionId: string, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE draft_sessions SET archived_at = ?, updated_at = ? WHERE connection_id = ?`)
    .bind(now.toISOString(), now.toISOString(), connectionId)
    .run();
}

/**
 * 006 T010 — kept players for a league and season, as `playerId → teamId`.
 *
 * FR-002 says available means "not drafted, and not already rostered
 * (INCLUDING KEEPERS)", so the engine needs to know who was kept before pick 1.
 *
 * WHERE THEY ACTUALLY COME FROM, honestly stated because the two paths differ:
 *
 *   * REPLAY (FR-014, SC-010) — from here. 005's archive records keepers in
 *     `draft_keepers` and flags them on `draft_picks`, so a replayed draft has
 *     them exactly as they were.
 *
 *   * LIVE — mostly NOT from here, and that is correct rather than a gap. The
 *     tap's ledger is a full snapshot of the draft board and ESPN marks kept
 *     selections within it, so during a live draft keepers arrive as picks and
 *     are already in `drafted`. This query returns an empty map before an
 *     archive exists, which is the honest answer: no archive, nothing to add.
 *
 * The engine takes the result as a SET on its state rather than looking it up
 * itself — it is told who is unavailable, it does not go asking (FR-010).
 */
export async function getArchiveKeepers(
  db: D1Database,
  accountId: string,
  connectionId: string,
  season: number,
): Promise<Map<number, number>> {
  const rows = await db
    .prepare(
      `SELECT k.player_id, k.team_id
         FROM draft_keepers k
         JOIN draft_archives a ON a.id = k.archive_id
        WHERE a.account_id = ? AND a.connection_id = ? AND a.season = ?`,
    )
    .bind(accountId, connectionId, season)
    .all<{ player_id: number; team_id: number }>();
  // Scoped to the account in the query, like every other read in this file —
  // one owner's draft must never be able to shape another's recommendations.
  return new Map((rows.results ?? []).map((r) => [r.player_id, r.team_id]));
}


/**
 * 011 T041/T042 — return a session to un-started, in place.
 *
 * Clears the completion stamp AND the status together. Clearing only one leaves
 * the split state this feature exists to remove: a session that looks fine and
 * can never reach `live`, because that transition requires
 * `completed_at IS NULL`.
 *
 * Deliberately does NOT touch the connection, its snapshot, its preferred list,
 * retained frames or any archive (FR-028, FR-029). The workaround this replaces
 * — disconnect and reconnect — destroyed a preferred player on 2026-08-06, and
 * capture history must survive a reset because 008's corpus may depend on it.
 *
 * The caller is responsible for refusing this during a live draft (FR-030);
 * that guard is shared with the sync-observed void (FR-031d2) rather than
 * duplicated here, because two copies of a live-draft guard will diverge and
 * the one that diverges is the one that fires at the wrong moment.
 */
export async function resetSession(db: D1Database, connectionId: string, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE draft_sessions
          SET status = 'idle', completed_at = NULL, archived_at = NULL, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(now.toISOString(), connectionId)
    .run();
}

/**
 * 011 T012 — is ANYONE in this league relaying right now?
 *
 * A different question from "is my tap alive", and the room has to ask this one.
 * Under fan-out a manager who runs no tap still has an armed session, but
 * `recordHeartbeat` only ever touches the RELAYER's row — so their own
 * `last_heartbeat_at` stays NULL forever. `heartbeatLapsed` reads a null
 * heartbeat as "not lapsed" by design (there is nothing to be stale about), so
 * asking the viewer's own row reported a healthy relay to a manager in a league
 * where nobody was relaying at all. The room would say **Live** with no feed
 * behind it — the precise failure this whole feature exists to stop.
 *
 * Entitlement is the same predicate the frame read uses, and for the same
 * reason: a manager who may not see the league's frames must not be told a relay
 * is running that they will never receive. That is worse than saying nothing.
 *
 * Returns the most recent heartbeat the asker is entitled to see, with the
 * `hidden` flag that decides which lapse threshold applies. The flag is used to
 * DERIVE liveness and is not itself for publishing — it is a fact about someone
 * else's browser tab.
 */
export async function latestLeagueHeartbeat(
  db: D1Database,
  readerConnectionId: string,
  espnLeagueId: string,
  season: number,
): Promise<{ lastHeartbeatAt: string; hidden: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT s.last_heartbeat_at, s.heartbeat_hidden
         FROM draft_sessions s
         JOIN league_connections c ON c.id = s.connection_id
        WHERE c.espn_league_id = ? AND c.season = ?
          AND s.last_heartbeat_at IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM league_connections r
                 WHERE r.id = ?
                   AND r.espn_league_id = c.espn_league_id
                   AND r.season = c.season
                   AND (r.team_match_source = 'auto' OR r.account_id = c.account_id)
              )
        ORDER BY s.last_heartbeat_at DESC
        LIMIT 1`,
    )
    .bind(espnLeagueId, season, readerConnectionId)
    .first<{ last_heartbeat_at: string; heartbeat_hidden: number }>();
  return row ? { lastHeartbeatAt: row.last_heartbeat_at, hidden: row.heartbeat_hidden === 1 } : null;
}

// --- 011 US8: remembering, and forgetting, what ESPN said -------------------

/** Set the first time ESPN reports this draft complete. Never overwritten. */
export async function rememberEspnCompletion(db: D1Database, connectionId: string, at: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE league_snapshots SET espn_draft_completed_at = COALESCE(espn_draft_completed_at, ?)
        WHERE connection_id = ?`,
    )
    .bind(at.toISOString(), connectionId)
    .run();
}

/** Raise or clear the suspicion that a reset has happened. */
export async function setResetSuspicion(
  db: D1Database,
  connectionId: string,
  at: Date | null,
): Promise<void> {
  await db
    .prepare(`UPDATE league_snapshots SET espn_reset_suspected_at = ? WHERE connection_id = ?`)
    .bind(at ? at.toISOString() : null, connectionId)
    .run();
}

/**
 * 011 T052 — forget that ESPN ever reported this draft complete.
 *
 * The MEMORY half of a void, and deliberately nothing else. It used to clear
 * the `draft_sessions` rows too and stop there, which left every Durable Object
 * still holding the previous draft's picks — so the rows read `idle` while the
 * rooms showed 72 stale picks. Clearing a session is now `resetLeagueSessions`
 * in `src/draft/reset.ts`, which owns BOTH stores; this function can no longer
 * be mistaken for it.
 *
 * Clearing the memory is what takes the league out of the post-draft watch and
 * lets a genuinely new draft set it again. Retained frames and archives are
 * untouched (FR-031c) — a draft that really happened stays history.
 */
export async function clearEspnCompletionMemory(
  db: D1Database,
  espnLeagueId: string,
  season: number,
): Promise<void> {
  const rows = await db
    .prepare(`SELECT id FROM league_connections WHERE espn_league_id = ? AND season = ?`)
    .bind(espnLeagueId, season)
    .all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE league_snapshots
          SET espn_draft_completed_at = NULL, espn_reset_suspected_at = NULL
        WHERE connection_id IN (${marks})`,
    )
    .bind(...ids)
    .run();
}

/**
 * 013 — a tap that RELAYS A PICK is alive. Record that.
 *
 * Liveness counted only the separate `/status` heartbeat. So a tap delivering a
 * pick every twenty seconds was judged dead after forty-five seconds of status
 * silence, and the room withheld recommendations while receiving that tap's
 * picks perfectly. It happened during a real draft on 2026-08-07, to both
 * managers at once, and needed a manual workaround to finish the draft.
 *
 * Relaying is the STRONGEST evidence a tap is alive — stronger than a heartbeat,
 * which only says the script is loaded. Refusing to count it meant the system
 * held proof of the thing it was reporting as absent.
 *
 * Deliberately narrow: only `last_heartbeat_at`, and only for the connection
 * whose tap actually sent the batch. `heartbeat_hidden` is NOT touched — the tap
 * is the only party that can observe its own tab, and a batch says nothing about
 * that. Under fan-out the league-wide read takes the freshest across managers,
 * so recording the relayer's row is enough for everyone.
 */
export async function recordRelayActivity(db: D1Database, connectionId: string, now: Date): Promise<void> {
  await db
    .prepare(
      `UPDATE draft_sessions
          SET last_heartbeat_at = ?, updated_at = ?
        WHERE connection_id = ?`,
    )
    .bind(now.toISOString(), now.toISOString(), connectionId)
    .run();
}
