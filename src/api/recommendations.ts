// 006 T029/T034/T048 — the engine's read surface.
//
// ═══════════════════════════════════════════════════════════════════════════
// FR-015 — AN OBLIGATION ON WHOEVER CALLS THIS. See contracts/api.md §1a.
//
//   Consumers MUST ensure a recommendation reflecting the CURRENT draft state
//   is already available when the owner's turn begins.
//
// CORRECTED 2026-08-05 by 007. This comment used to say "issue this request on
// `on_deck`, NOT on `on_the_clock`" — which was impossible at a snake
// turnaround (005's `on_deck` fires "at most two picks ahead", and the owner's
// second consecutive turn is one pick away, so no such event can exist), and
// which prescribed a mechanism where it meant an outcome.
//
// 007 satisfies it by refreshing on EVERY pick, with one request in flight and
// one trailing: the board is never more than a round trip stale, no single
// request is load-bearing, and the turnaround stops being a special case.
//
// 006 ships this endpoint; 007 ships the draft room that must call it correctly,
// and SC-005 is measured against that call site. It is written here, and in the
// contract, and in ROADMAP under 007, because a capability nobody invokes is
// indistinguishable from one that does not exist — which is exactly what
// happened to `writeArchive` during 005, where production showed zero archives
// after a completed draft.
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything here is a read. The engine writes nothing, and issues ZERO
// outbound requests — asserted structurally in the replay by exhausting the
// fetch mock.

import { Hono } from "hono";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById } from "../db/leagues";
import { getArchiveKeepers, getSession } from "../db/draft";
import { loadEngineBundle, NoProjectionsError } from "../db/engineBundle";
import { sessionStub } from "../draft/session";
import { withholdReason, type TapReportedState } from "../draft/liveness";
import { deriveState, type PlayerInfo } from "../engine/state";
import { explainPlayer, recommend } from "../engine/recommend";
import type { EngineBundle, EngineState } from "../engine/types";
import { currentSeason } from "../espn/leagueRef";
import { now, type Env } from "../env";

/** Human wording for 005's withhold reasons, so the surface says what to do. */
const WITHHOLD_DETAIL: Record<string, string> = {
  not_receiving:
    "The draft tap has stopped reporting, so picks are being missed. Check the tab running the tap.",
  incompatible: "The tap saw a message it does not understand, so picks are provably being missed.",
  version_rejected: "The tap is running a version this server no longer accepts. Update the userscript.",
};

/**
 * Everything `recommend()` needs, gathered from D1 and the session.
 *
 * Takes the env and the account id rather than the request context: the two
 * routes need identical assembly, and threading a Hono context through would
 * couple this to the framework for no benefit.
 */
async function assemble(
  env: Env,
  accountId: string,
  connectionId: string,
  myTeamId: number | null,
): Promise<{ bundle: EngineBundle; state: EngineState } | Response> {
  const t = now(env);
  const row = await getSession(env.DB, connectionId);
  const season = row?.season ?? currentSeason(t);

  let bundle: EngineBundle;
  try {
    bundle = await loadEngineBundle(env.DB, accountId, connectionId, season, t);
  } catch (err) {
    if (err instanceof NoProjectionsError) {
      // Matches `/board`'s existing behaviour for the same cause, rather than
      // inventing a second vocabulary for "we have no projections".
      return jsonError(409, "no_projections", "Projections haven't been fetched yet — trigger a refresh.");
    }
    throw err;
  }

  // 005's verdict, reused verbatim. A second liveness notion here would be a
  // second thing to keep in step, and they would drift on the day it mattered.
  const withholding = row
    ? withholdReason({
        lastHeartbeatAt: row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : null,
        hidden: row.heartbeat_hidden === 1,
        now: t.getTime(),
        tapState: (row.tap_state as TapReportedState | null) ?? null,
      })
    : null;

  const snap = row ? await sessionStub(env, connectionId, season).snapshot() : null;

  const playerInfo = new Map<number, PlayerInfo>(
    bundle.players.map((p) => [p.espn_player_id, { position: p.position, byeWeek: p.bye_week }]),
  );

  const state = deriveState({
    revision: snap?.revision ?? 0,
    picks: snap?.picks ?? [],
    // The session holds the order; before arming there is none, and the engine
    // degrades to "no turn arithmetic" rather than inventing a schedule.
    order: [],
    myTeamId,
    totalPicks: snap?.totalPicks ?? 0,
    keepers: await getArchiveKeepers(env.DB, accountId, connectionId, season),
    playerInfo,
    withholding: withholding
      ? { reason: withholding, detail: WITHHOLD_DETAIL[withholding] ?? "The draft picture is not trustworthy." }
      : null,
  });

  return { bundle, state };
}

export function recommendationRoutes() {
  const app = new Hono<AppContext>();

  /**
   * The ranked board (FR-001).
   *
   * A WITHHELD response is a 200 with empty `entries`, not an error status: the
   * question was answered, and the answer is "I will not guess" (FR-012).
   */
  app.get("/:id/recommendations", async (c) => {
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const assembled = await assemble(c.env, c.get("accountId"), connection.id, connection.my_team_id);
    if (assembled instanceof Response) return assembled;

    const board = recommend(assembled.bundle, assembled.state);
    return Response.json({
      revision: board.revision,
      withheld: board.withheld,
      forced: board.forced,
      round_value: board.roundValue,
      freshness: {
        fetched_at: assembled.bundle.freshness.fetchedAt,
        stale: assembled.bundle.freshness.stale,
      },
      warnings: board.warnings,
      shortlist: board.shortlist,
      entries: board.entries,
    });
  });

  /** The on-demand explanation for a player below the shortlist head (FR-009). */
  app.get("/:id/recommendations/players/:playerId", async (c) => {
    const connection = await getConnectionById(c.env.DB, c.get("accountId"), c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const playerId = Number(c.req.param("playerId"));
    // NEVER filtered on sign — D/ST ids are legitimately negative.
    if (!Number.isInteger(playerId)) return jsonError(404, "unknown_player", "No such player.");

    const assembled = await assemble(c.env, c.get("accountId"), connection.id, connection.my_team_id);
    if (assembled instanceof Response) return assembled;

    const found = explainPlayer(assembled.bundle, assembled.state, playerId);
    if (!found) {
      return jsonError(404, "unknown_player", "That player is not available in this draft.");
    }
    return Response.json({ revision: assembled.state.revision, ...found });
  });

  return app;
}
