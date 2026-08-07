import { iso, uuid } from "./client";
import type { ParsedLeague } from "../espn/parsers";

export interface ConnectionRow {
  id: string;
  account_id: string;
  espn_league_id: string;
  season: number;
  my_team_id: number;
  team_match_source: "auto" | "manual";
  created_at: string;
  last_sync_at: string | null;
  last_sync_status: "ok" | "failed" | "pending";
}

export interface SnapshotRow {
  connection_id: string;
  captured_at: string;
  league_name: string;
  team_count: number;
  scoring_json: string;
  roster_json: string;
  draft_json: string;
  teams_json: string;
  draft_at: string | null;
  /**
   * 011 US8 — when ESPN itself first reported this draft complete.
   *
   * Monotonic: set once, never cleared by a sync, cleared only by a confirmed
   * void. The snapshot around it is overwritten on every refresh, which is
   * exactly why this cannot live inside `draft_json`.
   */
  espn_draft_completed_at: string | null;
  /** A qualifying reset observation is standing, awaiting a second one. */
  espn_reset_suspected_at: string | null;
}

export async function findConnection(
  db: D1Database,
  accountId: string,
  leagueId: string,
  season: number,
): Promise<ConnectionRow | null> {
  return db
    .prepare(
      "SELECT * FROM league_connections WHERE account_id = ? AND espn_league_id = ? AND season = ?",
    )
    .bind(accountId, leagueId, season)
    .first<ConnectionRow>();
}

/**
 * 011 T002 — every connection to one league and season, ACROSS ACCOUNTS.
 *
 * THE ONLY QUERY IN THIS MODULE THAT DELIBERATELY CROSSES ACCOUNTS, and the
 * reason is worth stating where someone will read it.
 *
 * A draft's picks are a league-shared event: every manager in that ESPN room is
 * already watching them. So when one manager's tap relays, the frames belong to
 * the DRAFT, not to the relayer — and this is the audience they go to. Before
 * this, delivery was scoped to whoever happened to be relaying, which was never
 * a decision anybody made: the session is addressed by connection because that
 * is where the owner's team id lives. Measured cost on 2026-08-05: a leaguemate
 * relayed 71 batches while the owner relayed 1, and the owner saw nothing.
 *
 * WHAT THIS DOES NOT DO, and must never do: hand one manager another's
 * PERSPECTIVE. It returns connections so each one's own session can be armed
 * with its own scope — own team, own settings, own preferred list. The
 * constitution's isolation rule covers "another user's leagues, credentials, or
 * preferred lists"; none of those cross here, and the caller must keep it that
 * way (`tests/draft/scope.test.ts`).
 *
 * Callers must also not disclose WHICH manager relayed (011 FR-003): that a
 * particular person uses Draft Genie is the only genuinely private fact in the
 * exchange.
 */
export async function listConnectionsForLeague(
  db: D1Database,
  leagueId: string,
  season: number,
): Promise<ConnectionRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM league_connections WHERE espn_league_id = ? AND season = ? ORDER BY id",
    )
    .bind(leagueId, season)
    .all<ConnectionRow>();
  // Ordered by id so a fan-out arms in a stable sequence — a test that asserts
  // on the audience should not depend on insertion order.
  return res.results;
}

export async function getConnectionById(
  db: D1Database,
  accountId: string,
  connectionId: string,
): Promise<ConnectionRow | null> {
  // Account-scoped by construction: cross-account ids come back null → 404 (FR-003).
  return db
    .prepare("SELECT * FROM league_connections WHERE id = ? AND account_id = ?")
    .bind(connectionId, accountId)
    .first<ConnectionRow>();
}

export async function getSnapshot(db: D1Database, connectionId: string): Promise<SnapshotRow | null> {
  return db
    .prepare("SELECT * FROM league_snapshots WHERE connection_id = ?")
    .bind(connectionId)
    .first<SnapshotRow>();
}

function snapshotStatements(
  db: D1Database,
  connectionId: string,
  parsed: ParsedLeague,
  now: Date,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO league_snapshots (connection_id, captured_at, league_name, team_count, scoring_json, roster_json, draft_json, teams_json, draft_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET
         captured_at = excluded.captured_at,
         league_name = excluded.league_name,
         team_count = excluded.team_count,
         scoring_json = excluded.scoring_json,
         roster_json = excluded.roster_json,
         draft_json = excluded.draft_json,
         teams_json = excluded.teams_json,
         draft_at = excluded.draft_at`,
    )
    .bind(
      connectionId,
      iso(now),
      parsed.league_name,
      parsed.team_count,
      JSON.stringify(parsed.scoring),
      JSON.stringify(parsed.roster),
      JSON.stringify(parsed.draft),
      JSON.stringify(parsed.teams),
      parsed.draft.scheduled_at,
    );
}

/** Connection + first snapshot land atomically (no partial connections — spec edge case). */
export async function createConnectionWithSnapshot(
  db: D1Database,
  accountId: string,
  leagueId: string,
  season: number,
  myTeamId: number,
  matchSource: "auto" | "manual",
  parsed: ParsedLeague,
  now: Date,
): Promise<ConnectionRow> {
  const row: ConnectionRow = {
    id: uuid(),
    account_id: accountId,
    espn_league_id: leagueId,
    season,
    my_team_id: myTeamId,
    team_match_source: matchSource,
    created_at: iso(now),
    last_sync_at: iso(now),
    last_sync_status: "ok",
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO league_connections (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_at, last_sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.account_id,
        row.espn_league_id,
        row.season,
        row.my_team_id,
        row.team_match_source,
        row.created_at,
        row.last_sync_at,
        row.last_sync_status,
      ),
    snapshotStatements(db, row.id, parsed, now),
  ]);
  return row;
}

export async function recordSyncSuccess(
  db: D1Database,
  connectionId: string,
  parsed: ParsedLeague,
  now: Date,
): Promise<void> {
  await db.batch([
    snapshotStatements(db, connectionId, parsed, now),
    db
      .prepare("UPDATE league_connections SET last_sync_at = ?, last_sync_status = 'ok' WHERE id = ?")
      .bind(iso(now), connectionId),
  ]);
}

/** FR-020: failure leaves the previous snapshot untouched, only flags status. */
export async function recordSyncFailure(db: D1Database, connectionId: string): Promise<void> {
  await db
    .prepare("UPDATE league_connections SET last_sync_status = 'failed' WHERE id = ?")
    .bind(connectionId)
    .run();
}

export interface ConnectionWithSnapshot {
  connection: ConnectionRow;
  snapshot: SnapshotRow;
}

/** Dashboard order: soonest upcoming draft first, no-date leagues last (FR-021). */
export async function listConnections(
  db: D1Database,
  accountId: string,
): Promise<ConnectionWithSnapshot[]> {
  const res = await db
    .prepare(
      `SELECT c.id AS c_id, c.*, s.*
       FROM league_connections c JOIN league_snapshots s ON s.connection_id = c.id
       WHERE c.account_id = ?
       ORDER BY CASE WHEN s.draft_at IS NULL THEN 1 ELSE 0 END, s.draft_at ASC`,
    )
    .bind(accountId)
    .all<Record<string, unknown>>();
  return res.results.map(splitJoinedRow);
}

export async function deleteConnection(db: D1Database, accountId: string, connectionId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM league_connections WHERE id = ? AND account_id = ?")
    .bind(connectionId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listConnectionsByAccount(db: D1Database, accountId: string): Promise<ConnectionRow[]> {
  const res = await db
    .prepare("SELECT * FROM league_connections WHERE account_id = ?")
    .bind(accountId)
    .all<ConnectionRow>();
  return res.results;
}

/** Cron scan (FR-019): drafts scheduled within [now−15 m, now+75 m], not completed. */
export async function findPreDraftWindowConnections(
  db: D1Database,
  now: Date,
): Promise<ConnectionWithSnapshot[]> {
  const lower = iso(new Date(now.getTime() - 15 * 60_000));
  const upper = iso(new Date(now.getTime() + 75 * 60_000));
  const res = await db
    .prepare(
      `SELECT c.id AS c_id, c.*, s.*
       FROM league_connections c JOIN league_snapshots s ON s.connection_id = c.id
       WHERE s.draft_at IS NOT NULL AND s.draft_at >= ? AND s.draft_at <= ?`,
    )
    .bind(lower, upper)
    .all<Record<string, unknown>>();
  return res.results
    .map(splitJoinedRow)
    .filter(({ snapshot }) => !(JSON.parse(snapshot.draft_json) as { completed: boolean }).completed);
}

function splitJoinedRow(r: Record<string, unknown>): ConnectionWithSnapshot {
  return {
    connection: {
      id: r.c_id as string,
      account_id: r.account_id as string,
      espn_league_id: r.espn_league_id as string,
      season: r.season as number,
      my_team_id: r.my_team_id as number,
      team_match_source: r.team_match_source as "auto" | "manual",
      created_at: r.created_at as string,
      last_sync_at: r.last_sync_at as string | null,
      last_sync_status: r.last_sync_status as "ok" | "failed" | "pending",
    },
    snapshot: {
      connection_id: r.connection_id as string,
      captured_at: r.captured_at as string,
      league_name: r.league_name as string,
      team_count: r.team_count as number,
      scoring_json: r.scoring_json as string,
      roster_json: r.roster_json as string,
      draft_json: r.draft_json as string,
      teams_json: r.teams_json as string,
      draft_at: r.draft_at as string | null,
      espn_draft_completed_at: (r.espn_draft_completed_at as string | null) ?? null,
      espn_reset_suspected_at: (r.espn_reset_suspected_at as string | null) ?? null,
    },
  };
}

/**
 * 011 T055 (SC-009a) — leagues to keep watching AFTER their draft finished.
 *
 * `findPreDraftWindowConnections` can never do this. It selects on
 * `draft_at IS NOT NULL` inside a window, and a reset CLEARS ESPN's draft date
 * (measured, 011 T001) — which the very sync that would notice writes back. So
 * `draft_at` is an absorbing state: a completed league is excluded by that and
 * by its `completed` flag, and the exclusion never lifts by itself. Without
 * this, "the next sync" means an owner opening the app, and SC-009a's "with no
 * action by the owner" is not satisfiable at all.
 *
 * The selector is the completion MEMORY, which is the one thing a reset does
 * not erase and a sync does not overwrite. A league leaves the watch the moment
 * it is voided, and re-enters if ESPN reports a new draft complete.
 *
 * Bounded on three axes so this cannot grow across a season: only leagues whose
 * draft finished inside the window, only those not synced recently, and only a
 * page of them per tick.
 */
export const POST_DRAFT_WATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const POST_DRAFT_WATCH_INTERVAL_MS = 15 * 60 * 1000;
const POST_DRAFT_WATCH_PAGE = 25;

export async function findPostDraftWatchConnections(
  db: D1Database,
  now: Date,
): Promise<ConnectionWithSnapshot[]> {
  const windowFloor = iso(new Date(now.getTime() - POST_DRAFT_WATCH_WINDOW_MS));
  const cadenceFloor = iso(new Date(now.getTime() - POST_DRAFT_WATCH_INTERVAL_MS));
  const res = await db
    .prepare(
      `SELECT c.id AS c_id, c.*, s.*
         FROM league_connections c JOIN league_snapshots s ON s.connection_id = c.id
        WHERE s.espn_draft_completed_at IS NOT NULL
          AND s.espn_draft_completed_at >= ?
          AND (c.last_sync_at IS NULL OR c.last_sync_at <= ?)
        ORDER BY c.last_sync_at ASC
        LIMIT ${POST_DRAFT_WATCH_PAGE}`,
    )
    .bind(windowFloor, cadenceFloor)
    .all<Record<string, unknown>>();
  return res.results.map(splitJoinedRow);
}
