// 005 T025 — the draft session's read surface.
//
// Session-authenticated (mounted AFTER the `/api/*` middleware, unlike the
// tap-facing routes which carry their own bearer credential). Everything here
// is a read: the session is written only by the tap's ingest.

import { Hono } from "hono";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getConnectionById } from "../db/leagues";
import { getSession } from "../db/draft";
import { sessionStub } from "../draft/session";
import { heartbeatLapsed, withholdReason, type TapReportedState } from "../draft/liveness";
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
    const withhold = withholdReason({
      lastHeartbeatAt,
      hidden,
      now: at,
      tapState: (row.tap_state as TapReportedState | null) ?? null,
    });

    return Response.json({
      armed: true,
      status: row.status,
      season: row.season,
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

  return app;
}
