// Refresh orchestration (FR-015..FR-017): fetch → upsert universe → write a
// `building` projection set → atomic flip to `complete`. Any failure leaves
// the previous serving set untouched; the orphaned building row is swept by
// pruning. All-or-nothing, never partial.

import type { Env } from "../env";
import { EspnError } from "../espn/types";
import { fetchPlayers, fetchProTeams } from "./espnSource";
import { upsertPlayers, upsertProTeams } from "../db/players";
import {
  completeSet,
  createBuildingSet,
  insertProjectionRows,
  type ProjectionTrigger,
} from "../db/projections";
import { logError, logInfo } from "../api/logging";

// Sanity gate: a real ESPN fetch yields ~1,000+ projected players; anything
// tiny is a malformed response, not a valid set (FR-017 spirit).
// PROJECTION_MIN_PLAYERS env override exists for fixture-driven tests only.
const DEFAULT_MIN_PROJECTED = 300;

export type IngestResult =
  | { ok: true; setId: string; fetchedAt: string; playerCount: number }
  | { ok: false; code: "source_unreachable" | "source_invalid" };

export async function ingestProjections(
  env: Env,
  season: number,
  trigger: ProjectionTrigger,
  now: Date,
): Promise<IngestResult> {
  const minProjected = env.PROJECTION_MIN_PLAYERS ? Number(env.PROJECTION_MIN_PLAYERS) : DEFAULT_MIN_PROJECTED;
  try {
    const [teams, players] = await Promise.all([fetchProTeams(env, season), fetchPlayers(env, season)]);
    const projected = players.filter((p) => p.statLine !== null);
    if (projected.length < minProjected) {
      logError(`projection ingest rejected: only ${projected.length} projected players`);
      return { ok: false, code: "source_invalid" };
    }

    await upsertProTeams(env.DB, teams);
    await upsertPlayers(env.DB, players, now);

    const set = await createBuildingSet(env.DB, season, trigger, now);
    await insertProjectionRows(
      env.DB,
      set.id,
      projected.map((p) => ({
        espn_player_id: p.espnPlayerId,
        stats_json: JSON.stringify(p.statLine),
        adp: p.adp,
        overall_rank: p.overallRank,
      })),
    );
    await completeSet(env.DB, set.id, projected.length);
    logInfo(`projection ingest complete: ${projected.length} players (trigger=${trigger})`);
    return { ok: true, setId: set.id, fetchedAt: set.fetched_at, playerCount: projected.length };
  } catch (err) {
    logError("projection ingest failed", err);
    if (err instanceof EspnError) return { ok: false, code: "source_unreachable" };
    throw err;
  }
}
