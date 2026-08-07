// 005 T025 — the draft session's read surface.
//
// Session-authenticated (mounted AFTER the `/api/*` middleware, unlike the
// tap-facing routes which carry their own bearer credential). Every route here
// is a read except the reset added by 011 — the session's CONTENT is still
// written only by the tap's ingest; reset discards it, it does not author it.

import { Hono } from "hono";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById } from "../db/leagues";
import { getSession, latestLeagueHeartbeat } from "../db/draft";
import { resetOneSession } from "../draft/reset";
import { sessionStub } from "../draft/session";
import { heartbeatLapsed, isLiveDraft, withholdReason, type TapReportedState } from "../draft/liveness";
import { now } from "../env";

export function draftRoutes() {
  const app = new Hono<AppContext>();

  /**
   * Session status, including WHY advice is being withheld.
   *
   * The withholding reason is part of the contract rather than an internal
   * detail: FR-016 requires the surface to say what is wrong and what to do,
   * and "no recommendations" with no explanation is the silent failure this
   * feature exists to prevent.
   */
  app.get("/:id/draft", async (c) => {
    const accountId = c.get("accountId");
    const connection = await getConnectionById(c.env.DB, accountId, c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const row = await getSession(c.env.DB, connection.id);
    if (!row) {
      // Not armed yet. Honest absence, not an empty draft.
      return Response.json({
        armed: false,
        status: "idle",
        detail: "No draft session yet. It arms itself when the draft tap connects.",
      });
    }

    const at = now(c.env).getTime();
    const lastHeartbeatAt = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : null;
    const hidden = row.heartbeat_hidden === 1;
    // 011 — WITHHOLDING ASKS THE LEAGUE'S QUESTION, not the viewer's.
    //
    // The twin of the room-state bug, missed when that one was fixed. This
    // gates RECOMMENDATIONS, and it read the viewer's own heartbeat — so a
    // manager who runs no tap, which after fan-out is most of them, is judged
    // by a heartbeat that will never arrive and gets no advice for the whole
    // draft while a leaguemate relays perfectly.
    //
    // Falls back to the viewer's own row when the league has no heartbeat at
    // all, so a solo relayer is judged exactly as before.
    const leagueBeat = await latestLeagueHeartbeat(c.env.DB, connection.id);
    const withhold = withholdReason({
      lastHeartbeatAt: leagueBeat ? Date.parse(leagueBeat.lastHeartbeatAt) : lastHeartbeatAt,
      hidden: leagueBeat ? leagueBeat.hidden : hidden,
      now: at,
      // Still the viewer's own tap state: `incompatible` and `version_rejected`
      // are about a SCRIPT, and the league's freshest relay is the one that
      // matters for whether picks are arriving at all.
      tapState: (row.tap_state as TapReportedState | null) ?? null,
    });

    // 011 T012 — LEAGUE-wide relay liveness, from the same single read above.
    // The room asks "is anyone relaying?"; the tap page asks "is MY tap alive?".
    // Merging those two questions is how the surfaces drift — but they share one
    // fact, and reading it twice per request would be waste on the draft-day
    // path.
    const relayActive =
      leagueBeat !== null &&
      !heartbeatLapsed({ lastHeartbeatAt: Date.parse(leagueBeat.lastHeartbeatAt), hidden: leagueBeat.hidden, now: at });

    return Response.json({
      armed: true,
      status: row.status,
      season: row.season,
      // Whether SOMEONE is relaying, and when they last did. Deliberately not
      // who, and not their `hidden` flag — that is a fact about another
      // manager's browser tab, and FR-003 keeps a relayer's identity out of a
      // delivered view. The flag is used to derive `active`, not published.
      relay: { active: relayActive, lastRelayedAt: leagueBeat?.lastHeartbeatAt ?? null },
      tap: {
        state: row.tap_state,
        version: row.tap_version,
        // Reported so the surface can explain WHY the tolerance is wider: a
        // background tab's timers throttle to ~1/minute.
        hidden,
        lastHeartbeatAt: row.last_heartbeat_at,
        lapsed: heartbeatLapsed({ lastHeartbeatAt, hidden, now: at }),
      },
      withholding: withhold,
      completedAt: row.completed_at,
    });
  });

  /** The full current draft state. */
  app.get("/:id/draft/snapshot", async (c) => {
    const accountId = c.get("accountId");
    const connection = await getConnectionById(c.env.DB, accountId, c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const row = await getSession(c.env.DB, connection.id);
    const season = row?.season ?? new Date().getUTCFullYear();
    const snap = await sessionStub(c.env, connection.id, season).snapshot();
    if (!snap) return jsonError(409, "not_armed", "No draft session yet. It arms when the tap connects.");
    return Response.json(snap);
  });

  /**
   * 011 T044 — start over (FR-030).
   *
   * The first write on this router, which is why the header comment above says
   * everything here is a read. It is an OWNER action: `getConnectionById` is
   * account-scoped, so a manager can only reset their own session. Under
   * fan-out every session in a league sees the same frames, but they remain
   * separate objects — resetting yours leaves a leaguemate mid-draft untouched.
   *
   * Refused during a live draft unless explicitly confirmed. Not a
   * confirm-dialog reflex: this is the one action that discards a draft in
   * progress, and the request that reaches here during one is far more likely
   * to be a stale tab than an intention.
   */
  app.post("/:id/draft/reset", async (c) => {
    const accountId = c.get("accountId");
    const connection = await getConnectionById(c.env.DB, accountId, c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const row = await getSession(c.env.DB, connection.id);
    if (!row) return jsonError(409, "not_armed", "There is no draft session to reset.");

    const confirmed = c.req.query("confirm") === "true";
    const at = now(c.env);
    const live = isLiveDraft({
      status: row.status,
      completedAt: row.completed_at,
      lastHeartbeatAt: row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : null,
      hidden: row.heartbeat_hidden === 1,
      now: at.getTime(),
    });
    if (live && !confirmed) {
      return jsonError(
        409,
        "draft_is_live",
        "This draft looks like it is running right now. Resetting discards every pick captured so far. Confirm to reset anyway.",
      );
    }

    // The one reset path, shared with the observed-reset void. Ordering and
    // the two-store guarantee live there, so neither caller can get half of it.
    await resetOneSession(c.env, connection.id, row.season, at);

    return Response.json({ reset: true, wasLive: live });
  });

  /**
   * WebSocket upgrade (contracts/api.md).
   *
   * The cookie is authenticated HERE, at the edge, and the Durable Object is
   * called with a SYNTHESIZED request carrying no cookie and no session token.
   * The session never sees a credential — research §3, and the same posture as
   * the tap's ingest.
   */
  app.get("/:id/draft/stream", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return jsonError(426, "upgrade_required", "This endpoint speaks WebSocket.");
    }
    const accountId = c.get("accountId");
    const connection = await getConnectionById(c.env.DB, accountId, c.req.param("id"));
    if (!connection) return jsonError(404, "not_found", "That league is not connected to this account.");

    const row = await getSession(c.env.DB, connection.id);
    const season = row?.season ?? new Date().getUTCFullYear();

    const url = new URL(c.req.url);
    const forward = new URL("https://draft-session/stream");
    for (const key of ["since", "epoch"]) {
      const v = url.searchParams.get(key);
      if (v !== null) forward.searchParams.set(key, v);
    }
    return sessionStub(c.env, connection.id, season).fetch(
      new Request(forward, { headers: { Upgrade: "websocket" } }),
    );
  });

  return app;
}
