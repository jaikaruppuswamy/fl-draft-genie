// 006 T042 — the preferred-player list's read/write surface (FR-018, FR-019).
//
// ISOLATION (FR-020) IS ENFORCED IN THE SQL, not here. Every query in
// `db/preferred.ts` filters on `account_id`. The ownership check below is the
// SECOND line of defence, not the first — and it returns **404, never an empty
// list**, because an empty list confirms the connection exists and that is
// itself a leak.
//
// The constitution names preferred lists explicitly in its privacy section:
// "one user can never see another user's leagues, credentials, or preferred
// lists".

import { Hono } from "hono";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById } from "../db/leagues";
import { getSession } from "../db/draft";
import { addPreferred, listPreferred, removePreferred } from "../db/preferred";
import { getActivePlayer, listBoardUniverse } from "../db/players";
import { currentSeason } from "../espn/leagueRef";
import { now } from "../env";

export function preferredRoutes() {
  const app = new Hono<AppContext>();

  async function seasonFor(env: AppContext["Bindings"], connectionId: string, t: Date): Promise<number> {
    const row = await getSession(env.DB, connectionId);
    return row?.season ?? currentSeason(t);
  }

  /**
   * The current list, joined to the board.
   *
   * `on_board: false` is FR-021 in the contract: a released or retired player's
   * row SURVIVES, the page can say plainly that they cannot be used, and the
   * engine ignores them. Deleting the row instead would erase the owner's
   * intent because of something a nightly projection refresh noticed.
   */
  app.get("/:id/preferred", async (c) => {
    const t = now(c.env);
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const season = await seasonFor(c.env, connection.id, t);
    const rows = await listPreferred(c.env.DB, c.get("accountId"), connection.id, season);
    if (rows.length === 0) return Response.json({ season, players: [] });

    const universe = await listBoardUniverse(c.env.DB);
    const byId = new Map(universe.map((p) => [p.espn_player_id, p]));

    return Response.json({
      season,
      players: rows.map((r) => {
        const p = byId.get(r.espn_player_id);
        return {
          espn_player_id: r.espn_player_id,
          name: p?.full_name ?? null,
          position: p?.primary_position ?? null,
          team: p?.team_abbrev ?? null,
          on_board: p !== undefined,
        };
      }),
    });
  });

  /**
   * Idempotent add.
   *
   * 404s a player who is not in the board universe AT THE TIME OF THE REQUEST —
   * adding someone who never existed is a mistake worth reporting. A player who
   * LATER leaves the board is a different case entirely, and is kept (FR-021).
   */
  app.put("/:id/preferred/:playerId", async (c) => {
    const t = now(c.env);
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const playerId = Number(c.req.param("playerId"));
    // NEVER filtered on sign — D/ST ids are legitimately negative, near −16000.
    if (!Number.isInteger(playerId)) return jsonError(404, "unknown_player", "No such player.");
    if (!(await getActivePlayer(c.env.DB, playerId))) {
      return jsonError(404, "unknown_player", "No such player on the board.");
    }

    const season = await seasonFor(c.env, connection.id, t);
    await addPreferred(c.env.DB, c.get("accountId"), connection.id, season, playerId, t);
    return new Response(null, { status: 204 });
  });

  /** Idempotent remove — 204 whether or not the row was there. */
  app.delete("/:id/preferred/:playerId", async (c) => {
    const t = now(c.env);
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const playerId = Number(c.req.param("playerId"));
    if (!Number.isInteger(playerId)) return jsonError(404, "unknown_player", "No such player.");

    const season = await seasonFor(c.env, connection.id, t);
    await removePreferred(c.env.DB, c.get("accountId"), connection.id, season, playerId);
    return new Response(null, { status: 204 });
  });

  return app;
}
