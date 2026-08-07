import { Hono } from "hono";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById, getSnapshot } from "../db/leagues";
import { getActivePlayer, listBoardUniverse } from "../db/players";
import { getServingSet, getSetRowForPlayer, getSetRows } from "../db/projections";
import { buildLeagueBoard, round1, scoreStatLine } from "../projections/scoring";
import { isStale } from "../projections/freshness";
import { getSignalMaps, type SignalKind } from "../db/signals";
import { signalLabel } from "../signals/compute";
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
    // The board is what the engine builds, unmodified. This used to spread each
    // row to attach a positional tier; with tiering removed there is nothing to
    // add, and an identity map would just invite something to be added here
    // rather than in the builder.
    const players = buildLeagueBoard(universe, rows, scoring.items);

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
    const board = buildLeagueBoard(universe, rows, items);
    const found = board.find((b) => b.espn_player_id === playerId)!;
    const boardRow = {
      ...found,
    };

    const projection = await getSetRowForPlayer(c.env.DB, serving.id, playerId);
    const { total, breakdown } = scoreStatLine(
      projection ? (JSON.parse(projection.stats_json) as Record<string, number>) : null,
      items,
    );

    // 004: team context signals (nulls per contract for missing data / FA).
    const signalMaps = await getSignalMaps(c.env.DB);
    const kindBlock = (kind: SignalKind) => {
      if (player.pro_team_id === 0) return null;
      const v = signalMaps.get(kind)?.get(player.pro_team_id);
      return v ? { rank: v.rank, score: round1(v.score), label: signalLabel(kind, v.rank) } : null;
    };
    const signals = {
      offense: kindBlock("offense"),
      sos: kindBlock("sos"),
      oline: kindBlock("oline"),
      bye_week: player.pro_team_id === 0 ? null : player.bye_week,
    };

    return c.json({
      player: boardRow,
      freshness: { fetched_at: serving.fetched_at },
      breakdown,
      total: total === null ? null : round1(total),
      signals,
    });
  });

  return app;
}
