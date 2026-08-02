import { iso, uuid } from "./client";

export type ProjectionTrigger = "scheduled" | "on_demand" | "draft_day";

export interface ProjectionSetRow {
  id: string;
  season: number;
  source: string;
  status: "building" | "complete";
  trigger_kind: ProjectionTrigger;
  fetched_at: string;
  player_count: number | null;
}

export interface ProjectionRow {
  set_id: string;
  espn_player_id: number;
  stats_json: string;
  adp: number | null;
  overall_rank: number | null;
}

const CHUNK = 18; // 5 params/row → under D1's bound-param ceiling

export async function createBuildingSet(
  db: D1Database,
  season: number,
  trigger: ProjectionTrigger,
  now: Date,
): Promise<ProjectionSetRow> {
  const row: ProjectionSetRow = {
    id: uuid(),
    season,
    source: "espn",
    status: "building",
    trigger_kind: trigger,
    fetched_at: iso(now),
    player_count: null,
  };
  await db
    .prepare(
      "INSERT INTO projection_sets (id, season, source, status, trigger_kind, fetched_at, player_count) VALUES (?, ?, ?, 'building', ?, ?, NULL)",
    )
    .bind(row.id, row.season, row.source, row.trigger_kind, row.fetched_at)
    .run();
  return row;
}

export async function insertProjectionRows(
  db: D1Database,
  setId: string,
  rows: Omit<ProjectionRow, "set_id">[],
): Promise<void> {
  const statements = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO player_projections (set_id, espn_player_id, stats_json, adp, overall_rank) VALUES ${values}`,
        )
        .bind(...chunk.flatMap((r) => [setId, r.espn_player_id, r.stats_json, r.adp, r.overall_rank])),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

/** The atomic publish (FR-017): flipping to complete makes the set servable. */
export async function completeSet(db: D1Database, setId: string, playerCount: number): Promise<void> {
  await db
    .prepare("UPDATE projection_sets SET status = 'complete', player_count = ? WHERE id = ?")
    .bind(playerCount, setId)
    .run();
}

export async function getServingSet(db: D1Database, season: number): Promise<ProjectionSetRow | null> {
  return db
    .prepare(
      "SELECT * FROM projection_sets WHERE season = ? AND status = 'complete' ORDER BY fetched_at DESC LIMIT 1",
    )
    .bind(season)
    .first<ProjectionSetRow>();
}

/** Newest set of ANY status — the on-demand rate limit counts attempts, not successes. */
export async function getNewestSet(db: D1Database, season: number): Promise<ProjectionSetRow | null> {
  return db
    .prepare("SELECT * FROM projection_sets WHERE season = ? ORDER BY fetched_at DESC LIMIT 1")
    .bind(season)
    .first<ProjectionSetRow>();
}

export async function getSetRows(db: D1Database, setId: string): Promise<ProjectionRow[]> {
  const res = await db
    .prepare("SELECT * FROM player_projections WHERE set_id = ?")
    .bind(setId)
    .all<ProjectionRow>();
  return res.results;
}

export async function getSetRowForPlayer(
  db: D1Database,
  setId: string,
  espnPlayerId: number,
): Promise<ProjectionRow | null> {
  return db
    .prepare("SELECT * FROM player_projections WHERE set_id = ? AND espn_player_id = ?")
    .bind(setId, espnPlayerId)
    .first<ProjectionRow>();
}

/** FR-018: prune prior-season sets; sweep building corpses older than 1 h. */
export async function pruneSets(db: D1Database, currentSeason: number, now: Date): Promise<void> {
  const staleBuildingBefore = iso(new Date(now.getTime() - 60 * 60_000));
  await db.batch([
    db.prepare("DELETE FROM projection_sets WHERE season < ?").bind(currentSeason),
    db
      .prepare("DELETE FROM projection_sets WHERE status = 'building' AND fetched_at < ?")
      .bind(staleBuildingBefore),
  ]);
}
