import { Hono } from "hono";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById, getSnapshot } from "../db/leagues";
import { getActivePlayer, listBoardUniverse } from "../db/players";
import { getServingSet, getSetRowForPlayer, getSetRows } from "../db/projections";
import { buildLeagueBoard, round1, scoreStatLine } from "../projections/scoring";
import { isStale } from "../projections/freshness";
import { getTierMap } from "../db/tiers";
import { normalizeName, tierFormatForLeague } from "../tiers/borischen";
import { currentSeason } from "../espn/leagueRef";
import type { ScoringSnapshot } from "../espn/parsers";

async function leagueScoringFull(db: D1Database, connectionId: string): Promise<ScoringSnapshot> {
  const snapshot = await getSnapshot(db, connectionId);
  return JSON.parse(snapshot!.scoring_json) as ScoringSnapshot;
}

export function boardRoutes() {
  const app = new Hono<AppContext>();

  app.get("/:id/board", async (c) => {
    const t = now(c.env);
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "unknown_league", "No such league on your dashboard.");

    const serving = await getServingSet(c.env.DB, currentSeason(t));
    if (!serving) {
      return jsonError(
        409,
        "no_projections",
        "Projections haven't been fetched yet — trigger a refresh to load them.",
      );
    }

    const [scoring, universe, rows] = await Promise.all([
      leagueScoringFull(c.env.DB, connection.id),
      listBoardUniverse(c.env.DB),
      getSetRows(c.env.DB, serving.id),
    ]);
    const tierMap = await getTierMap(c.env.DB, tierFormatForLeague(scoring.reception_points));
    const players = buildLeagueBoard(universe, rows, scoring.items).map((p) => ({
      ...p,
      // Additive to the 002 contract (003 plan): positional tier or null.
      tier: tierMap.get(`${p.position}:${normalizeName(p.name, p.position)}`) ?? null,
    }));

    return c.json({
      freshness: {
        fetched_at: serving.fetched_at,
        season: serving.season,
        stale: isStale(serving.fetched_at, t),
      },
      players,
    });
  });

  app.get("/:id/board/players/:playerId", async (c) => {
    const t = now(c.env);
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "unknown_league", "No such league on your dashboard.");

    const playerId = Number(c.req.param("playerId"));
    if (!Number.isInteger(playerId)) return jsonError(404, "unknown_player", "No such player.");
    const player = await getActivePlayer(c.env.DB, playerId);
    if (!player) return jsonError(404, "unknown_player", "No such player.");

    const serving = await getServingSet(c.env.DB, currentSeason(t));
    if (!serving) {
      return jsonError(409, "no_projections", "Projections haven't been fetched yet.");
    }

    const scoring = await leagueScoringFull(c.env.DB, connection.id);
    const items = scoring.items;
    // Board recompute keeps points/ranks consistent with the board view.
    const [universe, rows] = await Promise.all([
      listBoardUniverse(c.env.DB),
      getSetRows(c.env.DB, serving.id),
    ]);
    const tierMap = await getTierMap(c.env.DB, tierFormatForLeague(scoring.reception_points));
    const board = buildLeagueBoard(universe, rows, items);
    const found = board.find((b) => b.espn_player_id === playerId)!;
    const boardRow = {
      ...found,
      tier: tierMap.get(`${found.position}:${normalizeName(found.name, found.position)}`) ?? null,
    };

    const projection = await getSetRowForPlayer(c.env.DB, serving.id, playerId);
    const { total, breakdown } = scoreStatLine(
      projection ? (JSON.parse(projection.stats_json) as Record<string, number>) : null,
      items,
    );

    return c.json({
      player: boardRow,
      freshness: { fetched_at: serving.fetched_at },
      breakdown,
      total: total === null ? null : round1(total),
    });
  });

  return app;
}
