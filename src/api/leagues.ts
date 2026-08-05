import { Hono } from "hono";
import { z } from "zod";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { getSession } from "../db/draft";
import { sessionStub } from "../draft/session";
import { logError } from "./logging";
import { getCredentials } from "../db/credentials";
import {
  deleteConnection,
  getConnectionById,
  getSnapshot,
  listConnections,
  type ConnectionRow,
  type SnapshotRow,
} from "../db/leagues";
import {
  scoringSummaryLabel,
  type DraftSnapshot,
  type RosterSnapshot,
  type ScoringSnapshot,
  type TeamSnapshot,
} from "../espn/parsers";
import { completeConnect, connectLeague, type ConnectOutcome } from "../sync/connect";
import { refreshConnection } from "../sync/refresh";

// Human guidance per machine code (SC-006: every error says what to do next).
const CONNECT_ERRORS: Record<string, { status: number; message: string }> = {
  no_credentials: { status: 422, message: "Add your ESPN cookies first, then connect the league." },
  credentials_failing: { status: 422, message: "Your stored ESPN cookies stopped working — refresh them, then retry." },
  unparseable_ref: { status: 422, message: "Paste the ESPN league URL or the numeric league ID." },
  league_not_found: { status: 422, message: "ESPN has no league with that ID for this season. Check the URL/ID." },
  not_football: { status: 422, message: "That league isn't a fantasy football league — only football is supported." },
  wrong_season: { status: 422, message: "That league isn't active for the current season." },
  already_connected: { status: 422, message: "This league is already on your dashboard." },
  espn_rejected: { status: 422, message: "ESPN rejected your stored cookies. Refresh them on the setup page." },
  espn_unreachable: { status: 502, message: "ESPN can't be reached right now. Nothing was saved — try again." },
  invalid_team: { status: 422, message: "Pick one of the teams listed for this league." },
  expired_connect_token: { status: 422, message: "That team-selection session expired — start the connect again." },
};

function summarize(
  c: { connection: ConnectionRow; snapshot: SnapshotRow },
  credStatus: "working" | "failing" | null,
) {
  const scoring = JSON.parse(c.snapshot.scoring_json) as ScoringSnapshot;
  const roster = JSON.parse(c.snapshot.roster_json) as RosterSnapshot;
  const draft = JSON.parse(c.snapshot.draft_json) as DraftSnapshot;
  const teams = JSON.parse(c.snapshot.teams_json) as TeamSnapshot[];
  const myTeam = teams.find((t) => t.espn_team_id === c.connection.my_team_id);
  return {
    id: c.connection.id,
    espn_league_id: c.connection.espn_league_id,
    season: c.connection.season,
    name: c.snapshot.league_name,
    team_count: c.snapshot.team_count,
    my_team: myTeam
      ? { espn_team_id: myTeam.espn_team_id, name: myTeam.name }
      : { espn_team_id: c.connection.my_team_id, name: `Team ${c.connection.my_team_id}` },
    scoring_summary: scoringSummaryLabel(scoring, roster),
    draft: {
      type: draft.type,
      supported: draft.supported,
      scheduled_at: draft.scheduled_at,
      order_published: draft.order !== null,
    },
    last_sync_at: c.connection.last_sync_at,
    sync_status: c.connection.last_sync_status,
    credentials_status: credStatus,
  };
}

function detail(
  c: { connection: ConnectionRow; snapshot: SnapshotRow },
  credStatus: "working" | "failing" | null,
  nowMs: number,
) {
  const scoring = JSON.parse(c.snapshot.scoring_json) as ScoringSnapshot;
  const roster = JSON.parse(c.snapshot.roster_json) as RosterSnapshot;
  const draft = JSON.parse(c.snapshot.draft_json) as DraftSnapshot;
  const teams = JSON.parse(c.snapshot.teams_json) as TeamSnapshot[];
  return {
    ...summarize(c, credStatus),
    scoring_rules: scoring.items,
    scoring_type: scoring.scoring_type,
    roster_slots: roster.slots,
    teams,
    draft_order: draft.order,
    snapshot_age_seconds: Math.max(0, Math.floor((nowMs - new Date(c.snapshot.captured_at).getTime()) / 1000)),
  };
}

async function credStatusFor(c: { env: { DB: D1Database } }, accountId: string) {
  const row = await getCredentials(c.env.DB, accountId);
  return row?.status ?? null;
}

function connectResponse(outcome: ConnectOutcome): Response | null {
  if (outcome.kind === "error") {
    const spec = CONNECT_ERRORS[outcome.code] ?? { status: 422, message: "Could not connect the league." };
    return jsonError(spec.status, outcome.code, spec.message);
  }
  if (outcome.kind === "team_choice_required") {
    return Response.json(
      {
        error: "team_choice_required",
        message: "We couldn't tell which team is yours — pick it from the list.",
        connect_token: outcome.connectToken,
        teams: outcome.teams,
      },
      { status: 409 },
    );
  }
  return null;
}

export function leagueRoutes() {
  const app = new Hono<AppContext>();

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ league_ref: z.string() }).safeParse(body);
    if (!parsed.success) return jsonError(422, "unparseable_ref", "Provide a league URL or ID.");
    const accountId = c.get("accountId");
    const outcome = await connectLeague(c.env, accountId, parsed.data.league_ref, now(c.env));
    const early = connectResponse(outcome);
    if (early) return early;
    const connection = (outcome as Extract<ConnectOutcome, { kind: "connected" }>).connection;
    const snapshot = (await getSnapshot(c.env.DB, connection.id))!;
    return c.json(detail({ connection, snapshot }, await credStatusFor(c, accountId), now(c.env).getTime()), 201);
  });

  app.post("/connect/complete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({ connect_token: z.string(), espn_team_id: z.number().int() })
      .safeParse(body);
    if (!parsed.success) return jsonError(422, "invalid_team", "Pick one of the teams listed for this league.");
    const accountId = c.get("accountId");
    const outcome = await completeConnect(
      c.env,
      accountId,
      parsed.data.connect_token,
      parsed.data.espn_team_id,
      now(c.env),
    );
    const early = connectResponse(outcome);
    if (early) return early;
    const connection = (outcome as Extract<ConnectOutcome, { kind: "connected" }>).connection;
    const snapshot = (await getSnapshot(c.env.DB, connection.id))!;
    return c.json(detail({ connection, snapshot }, await credStatusFor(c, accountId), now(c.env).getTime()), 201);
  });

  app.get("/", async (c) => {
    const accountId = c.get("accountId");
    const rows = await listConnections(c.env.DB, accountId);
    const credStatus = await credStatusFor(c, accountId);
    return c.json({ leagues: rows.map((r) => summarize(r, credStatus)) });
  });

  app.get("/:id", async (c) => {
    const accountId = c.get("accountId");
    const connection = await getConnectionById(c.env.DB, accountId, c.req.param("id"));
    if (!connection) return jsonError(404, "unknown_league", "No such league on your dashboard.");
    const snapshot = (await getSnapshot(c.env.DB, connection.id))!;
    return c.json(detail({ connection, snapshot }, await credStatusFor(c, accountId), now(c.env).getTime()));
  });

  // Manual re-sync (FR-018). A failed refresh of an existing league is never a
  // 5xx: stale data stays, labeled, with a warning (FR-020).
  app.post("/:id/sync", async (c) => {
    const accountId = c.get("accountId");
    const connection = await getConnectionById(c.env.DB, accountId, c.req.param("id"));
    if (!connection) return jsonError(404, "unknown_league", "No such league on your dashboard.");
    const t = now(c.env);
    const result = await refreshConnection(c.env, connection, t, { force: true });
    const fresh = (await getConnectionById(c.env.DB, accountId, connection.id))!;
    const snapshot = (await getSnapshot(c.env.DB, connection.id))!;
    const body = detail({ connection: fresh, snapshot }, await credStatusFor(c, accountId), t.getTime());
    return c.json(
      result === "failed"
        ? { ...body, warning: "ESPN couldn't be reached — showing the last synced settings." }
        : body,
    );
  });

  app.delete("/:id", async (c) => {
    const connectionId = c.req.param("id");
    // 005 T051: read the season BEFORE the row is deleted — afterwards there is
    // nothing left to derive the session's identity from.
    const session = await getSession(c.env.DB, connectionId);

    const removed = await deleteConnection(c.env.DB, c.get("accountId"), connectionId);
    if (!removed) return jsonError(404, "unknown_league", "No such league on your dashboard.");

    // Shut the draft session down explicitly. `draft_sessions` cascades from
    // `league_connections`, so the ROW goes — but the Durable Object does not:
    // it would keep its alarm scheduled and keep reading a log for a league
    // that no longer exists, with no row behind it. Re-adding the league mints
    // a new connection id and therefore a new object, so the orphan would
    // never be reached again either.
    if (session) {
      try {
        await sessionStub(c.env, connectionId, session.season).shutdown();
      } catch (e) {
        // The connection is already gone; a failure here must not turn a
        // successful disconnect into an error the owner sees.
        logError("draft session shutdown failed on disconnect", e as Error);
      }
    }
    return c.body(null, 204);
  });

  return app;
}
