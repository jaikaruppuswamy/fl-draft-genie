import { iso } from "./client";
import type { SourcePlayer, SourceProTeam } from "../projections/espnSource";

export interface PlayerRow {
  espn_player_id: number;
  full_name: string;
  primary_position: string;
  eligible_positions: string; // JSON array
  pro_team_id: number;
  active: number;
  injury_status: string | null;
  updated_at: string;
}

export interface BoardUniverseRow extends PlayerRow {
  team_abbrev: string | null;
  bye_week: number | null;
}

// D1 caps bound params at 100/statement: 12 rows x 8 params = 96 (players), 24 x 4 = 96 (teams).
const PLAYER_CHUNK = 12;
const TEAM_CHUNK = 24;

export async function upsertProTeams(db: D1Database, teams: SourceProTeam[]): Promise<void> {
  const statements = [];
  for (let i = 0; i < teams.length; i += TEAM_CHUNK) {
    const chunk = teams.slice(i, i + TEAM_CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO pro_teams (espn_team_id, abbrev, name, bye_week) VALUES ${values}
           ON CONFLICT (espn_team_id) DO UPDATE SET
             abbrev = excluded.abbrev, name = excluded.name, bye_week = excluded.bye_week`,
        )
        .bind(...chunk.flatMap((t) => [t.espnTeamId, t.abbrev, t.name, t.byeWeek])),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function upsertPlayers(db: D1Database, players: SourcePlayer[], now: Date): Promise<void> {
  const statements = [];
  for (let i = 0; i < players.length; i += PLAYER_CHUNK) {
    const chunk = players.slice(i, i + PLAYER_CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO players (espn_player_id, full_name, primary_position, eligible_positions, pro_team_id, active, injury_status, updated_at)
           VALUES ${values}
           ON CONFLICT (espn_player_id) DO UPDATE SET
             full_name = excluded.full_name,
             primary_position = excluded.primary_position,
             eligible_positions = excluded.eligible_positions,
             pro_team_id = excluded.pro_team_id,
             active = excluded.active,
             injury_status = excluded.injury_status,
             updated_at = excluded.updated_at`,
        )
        .bind(
          ...chunk.flatMap((p) => [
            p.espnPlayerId,
            p.fullName,
            p.primaryPosition,
            JSON.stringify(p.eligiblePositions),
            p.proTeamId,
            p.active ? 1 : 0,
            p.injuryStatus,
            iso(now),
          ]),
        ),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

/** Active players joined to team abbrev + bye — the board universe (FR-003). */
export async function listBoardUniverse(db: D1Database): Promise<BoardUniverseRow[]> {
  const res = await db
    .prepare(
      `SELECT p.*, t.abbrev AS team_abbrev, t.bye_week
       FROM players p LEFT JOIN pro_teams t ON t.espn_team_id = p.pro_team_id
       WHERE p.active = 1`,
    )
    .all<BoardUniverseRow>();
  return res.results;
}

export async function getActivePlayer(db: D1Database, espnPlayerId: number): Promise<BoardUniverseRow | null> {
  return db
    .prepare(
      `SELECT p.*, t.abbrev AS team_abbrev, t.bye_week
       FROM players p LEFT JOIN pro_teams t ON t.espn_team_id = p.pro_team_id
       WHERE p.espn_player_id = ? AND p.active = 1`,
    )
    .bind(espnPlayerId)
    .first<BoardUniverseRow>();
}
