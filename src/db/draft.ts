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
         status = excluded.status,
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
