import { Hono } from "hono";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById, getSnapshot } from "../db/leagues";
import { getActivePlayer, listBoardUniverse } from "../db/players";
import { getServingSet, getSetRowForPlayer, getSetRows } from "../db/projections";
import { buildLeagueBoard, round1, scoreStatLine, type ScoringItemLike } from "../projections/scoring";
import { isStale } from "../projections/freshness";
import { currentSeason } from "../espn/leagueRef";
import type { ScoringSnapshot } from "../espn/parsers";

async function leagueScoring(db: D1Database, connectionId: string): Promise<ScoringItemLike[]> {
  const snapshot = await getSnapshot(db, connectionId);
  const scoring = JSON.parse(snapshot!.scoring_json) as ScoringSnapshot;
  return scoring.items;
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

    const [items, universe, rows] = await Promise.all([
      leagueScoring(c.env.DB, connection.id),
      listBoardUniverse(c.env.DB),
      getSetRows(c.env.DB, serving.id),
    ]);

    return c.json({
      freshness: {
        fetched_at: serving.fetched_at,
        season: serving.season,
        stale: isStale(serving.fetched_at, t),
      },
      players: buildLeagueBoard(universe, rows, items),
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

    const items = await leagueScoring(c.env.DB, connection.id);
    // Board recompute keeps points/ranks consistent with the board view.
    const [universe, rows] = await Promise.all([
      listBoardUniverse(c.env.DB),
      getSetRows(c.env.DB, serving.id),
    ]);
    const board = buildLeagueBoard(universe, rows, items);
    const boardRow = board.find((b) => b.espn_player_id === playerId)!;

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
