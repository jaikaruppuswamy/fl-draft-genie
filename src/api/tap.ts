// 010 T030 — the tap ingest surface.
//
// THREE ROUTING TRAPS, all load-bearing (contracts/ingest.md):
//
//  1. These routes MUST be mounted BEFORE `app.use("/api/*", …)` in app.ts.
//     That middleware is a bare prefix match, so a tap POST reaching it first
//     returns 401 no matter how correct the token is.
//  2. The CORS preflight must exist. A cross-origin POST from
//     https://fantasy.espn.com triggers OPTIONS, and `src/` had no
//     Access-Control handling at all before this.
//  3. On an unlisted origin we OMIT the CORS headers rather than rejecting the
//     request. That is what the GM_xmlhttpRequest path needs — it is not
//     browser-CORS-constrained — and a 403 guard would break it.

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { now } from "../env";
import { logError, logInfo } from "./logging";
import { listPairings, retainBatch, revokePairing, summariseBatches, touchPairing, verifyPairing } from "../db/tap";
import { findConnection, getConnectionById, listConnectionsForLeague } from "../db/leagues";
import { sessionStub } from "../draft/session";
import { armingScope } from "../draft/arming";
import { getSnapshot } from "../db/leagues";
import { getSession, recordHeartbeat, recordRelayActivity, upsertSession } from "../db/draft";
import type { Env } from "../env";

/** The tap runs on ESPN's origin; nothing else needs these routes. */
const ALLOWED_ORIGINS = new Set(["https://fantasy.espn.com"]);

/** Wire-contract versions this Worker understands. A tap outside this set gets
 *  409 so it can tell the user to update, rather than being misread. */
export const SUPPORTED_CONTRACT_VERSIONS = new Set([1]);

/** Brace-form or bare SWID. Nothing numeric-only can match this. */
const GUID_ON_WIRE = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;

/**
 * 005 FR-007e. `hidden` is load-bearing, not telemetry: a background tab's
 * timers are throttled to ~1/minute, so a receiver applying one lapse
 * threshold would declare a healthy backgrounded tap dead. The tap is the only
 * party that can observe this, so it reports it.
 */
const statusBody = z.object({
  state: z.string().min(1).max(40),
  detail: z.string().max(300).optional(),
  tapVersion: z.string().max(20).optional(),
  heartbeat: z.boolean().optional(),
  hidden: z.boolean().optional(),
  league: z.object({ espnLeagueId: z.string().max(32), season: z.number().int() }).optional(),
});

const relayMessage = z.object({
  v: z.number().int(),
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  observedAt: z.string(),
  transport: z.enum(["ws", "sse"]),
  kind: z.enum(["pick", "ledger", "status"]),
  payload: z.unknown(),
});

const batchBody = z.object({
  v: z.number().int(),
  install: z.string().min(1).max(64),
  session: z.string().min(1).max(64),
  league: z.object({ espnLeagueId: z.string().min(1), season: z.number().int() }),
  // Optional AND empty-tolerant by design. The tap runs on ESPN's page and
  // knows the ESPN league id, not Draft Genie's internal UUID. Requiring it
  // meant every batch 400'd in production; requiring it to be NON-EMPTY meant
  // an already-installed tap sending "" still 400'd. The Worker resolves the
  // connection from (account, espnLeagueId, season) instead, and treats an
  // empty string as absent so a deployed script keeps working.
  connectionId: z.string().optional(),
  messages: z.array(relayMessage).max(200),
});

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tap-Install",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}


/**
 * 005 FR-007g — arm the session from ANY tap frame, heartbeat included.
 *
 * Arming on the heartbeat rather than the first pick is what makes a missing
 * or broken tap visible BEFORE the draft starts, while there is still time to
 * fix it. The tap heartbeats from the moment the draft room opens.
 *
 * Idempotent and cheap: it reads the snapshot 001 already maintains rather
 * than calling ESPN, so a 15-second heartbeat cannot breach FR-008's bound.
 */
async function armOne(
  env: Env,
  row: { id: string; account_id: string; my_team_id: number },
  espnLeagueId: string,
  season: number,
  at: Date,
): Promise<{ armed: ReturnType<typeof armingScope>; firstEver: boolean } | null> {
  // Read BEFORE the upsert: afterwards every connection looks like it has run
  // before. This is what tells a manager joining for the first time apart from
  // a session recovering after its object was evicted — the row outlives the
  // object, so its absence means genuinely new.
  const firstEver = (await getSession(env.DB, row.id)) === null;
  // Each manager's OWN snapshot. Reusing the relayer's to save N reads would
  // import one manager's stale sync into everyone's board, and would destroy
  // FR-005 by leaving no disagreement to surface — two managers in one league
  // recorded 11 and 12 rounds for the same draft on 2026-08-06.
  const snapshot = await getSnapshot(env.DB, row.id);
  const armed = armingScope({
    accountId: row.account_id,
    connectionId: row.id,
    espnLeagueId,
    season,
    myTeamId: row.my_team_id,
    snapshot,
  });
  await upsertSession(
    env.DB,
    {
      connectionId: row.id,
      accountId: row.account_id,
      season,
      status: armed.supported ? "armed" : "unsupported",
      scheduledAt: armed.scheduledAt,
    },
    at,
  );
  return armed.supported ? { armed, firstEver } : null;
}

/**
 * 011 T008/T009 — arm and nudge EVERY manager of this league (FR-001, FR-004).
 *
 * The change that makes Draft Genie work for someone who cannot run a
 * userscript. Sessions used to arm from their own tap's first frame, so a
 * manager without a tap had no session at all — not an empty draft, nothing to
 * attach to.
 *
 * FAN OUT, DO NOT RE-KEY. Each manager keeps their own Durable Object at
 * `connectionId:season`. Addressing one object by league would force perspective
 * back out of it and in per viewer, which is the layer whose absence caused the
 * perspective bleed this feature exists to fix.
 *
 * Three things here are load-bearing:
 *
 *  * THE RELAYER'S ROW IS WRITTEN SYNCHRONOUSLY, everyone else's after the
 *    response. The diagnostic surface and the liveness check read that row, and
 *    a heartbeat that did not record itself is worse than none. But this also
 *    runs from the 15-second `/status` heartbeat, so awaiting the whole audience
 *    would turn 2 D1 statements into 2N every 15 seconds per relaying tap —
 *    against the very rate bound the arming design exists to respect.
 *
 *  * ARM THEN NUDGE, CHAINED PER CONNECTION. As two independent `waitUntil`
 *    promises the nudge can land first, hit a session with no scope, return
 *    silently and set no alarm — `nudge()` only calls `ensureAlarm` when it
 *    throws, and nothing threw. The first pick would then wait out the 5 s
 *    safety alarm. Correct, and far outside the latency budget.
 *
 *  * ONE MANAGER'S FAILURE IS THEIR OWN. Each is wrapped separately: an early
 *    return on the first unsupported or broken manager would unarm the whole
 *    league, silently, for a reason that has nothing to do with them.
 */
async function armLeague(
  env: Env,
  relayer: { id: string; account_id: string; my_team_id: number },
  espnLeagueId: string,
  season: number,
  at: Date,
  ctx: WaitUntil | null,
  nudge: boolean,
): Promise<void> {
  const relayerArmed = await armOne(env, relayer, espnLeagueId, season, at);

  const run = async () => {
    // The relayer is already in this list — it is a connection of this league.
    // Adding it separately would double its writes per frame.
    const audience = await listConnectionsForLeague(env.DB, espnLeagueId, season);

    // TWO PASSES, and the reason is FR-005. The disagreement is a property of
    // the league, so it cannot be known until every manager's scope has been
    // built — arming as we go would give the first manager a null and the last
    // one the answer.
    const prepared: { row: (typeof audience)[number]; armed: ReturnType<typeof armingScope>; firstEver: boolean }[] = [];
    for (const row of audience) {
      try {
        const result = row.id === relayer.id ? relayerArmed : await armOne(env, row, espnLeagueId, season, at);
        if (!result) continue; // unsupported for THIS manager; the rest still arm
        prepared.push({ row, armed: result.armed, firstEver: result.firstEver });
      } catch {
        /* the next frame, or the cron sweep, will arm this one */
      }
    }

    // 0 means "not established yet", not a claim about the draft's length —
    // counting it would report a disagreement between a manager who knows and
    // one who has simply not synced.
    const totals = [...new Set(prepared.map((p) => p.armed.scope.totalPicks).filter((t) => t > 0))].sort(
      (a, b) => a - b,
    );
    const disagreement = totals.length > 1 ? { totals } : null;

    for (const p of prepared) {
      try {
        const stub = sessionStub(env, p.row.id, season);
        // A manager joining for the first time starts at the log's tip, not at
        // the beginning of a league-wide log that still holds old mock drafts.
        await stub.arm(
          { ...p.armed.scope, disagreement },
          { floorToLogTip: p.firstEver, floorBefore: at.toISOString() },
        );
        if (nudge) await stub.nudge();
      } catch {
        /* the next frame, or the cron sweep, will arm this one */
      }
    }
  };
  if (ctx) ctx.waitUntil(run());
}

/** Just the capability we need; Hono's ExecutionContext generic varies. */
interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

/** `executionCtx` THROWS when the app is invoked without one. */
function execCtx(c: { executionCtx: WaitUntil }): WaitUntil | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

export function tapRoutes() {
  const app = new Hono<AppContext>();

  app.options("/*", (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header("Origin")) }));

  // Unauthenticated liveness so the owner can verify the install without
  // waiting for a draft (FR-021, SC-006).
  app.get("/health", (c) =>
    Response.json({ ok: true, contract: [...SUPPORTED_CONTRACT_VERSIONS] }, { headers: corsHeaders(c.req.header("Origin")) }),
  );

  app.post("/batch", async (c) => {
    const cors = corsHeaders(c.req.header("Origin"));
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const installHeader = c.req.header("X-Tap-Install") ?? null;
    if (!token) return withCors(jsonError(401, "unpaired", "This browser is not linked to Draft Genie."), cors);

    const at = now(c.env);
    const verified = await verifyPairing(c.env.DB, token, installHeader, at);
    if (!verified.ok) {
      return withCors(
        jsonError(401, `pairing_${verified.reason}`, "Re-pair this browser in Draft Genie settings."),
        cors,
      );
    }

    const parsed = batchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return withCors(jsonError(400, "invalid_batch", "Malformed relay batch."), cors);
    const body = parsed.data;

    if (!SUPPORTED_CONTRACT_VERSIONS.has(body.v)) {
      return withCors(
        jsonError(409, "unsupported_version", "This version of the draft tap is too old. Please update it."),
        cors,
      );
    }

    // The league must belong to the authenticated account (FR-018 / 005
    // FR-007d). Both lookups are account-scoped, so ownership is enforced by
    // the query rather than by a comparison we could forget.
    //
    // That claim was true of the ACCOUNT and false of the LEAGUE. `findConnection`
    // looks the row up BY league, so the body is validated on that path. But
    // `getConnectionById` validates id + account only — nothing compared
    // `body.league` against the row it returned, and `body.league` was then used
    // authoritatively for the stored row, the arming and the session address.
    // `tap_batches.espn_league_id` is plain TEXT with no foreign key, so a batch
    // could be stored stamped with a league the sender has nothing to do with.
    //
    // Inert while frame reads are account-scoped — only the author could read
    // the forged row. 011's league-scoped read is what would arm it, so this is
    // a precondition of that change rather than a follow-up.
    const connection = body.connectionId
      ? await getConnectionById(c.env.DB, verified.accountId, body.connectionId)
      : await findConnection(c.env.DB, verified.accountId, body.league.espnLeagueId, body.league.season);
    if (!connection) {
      return withCors(
        jsonError(
          403,
          "not_your_league",
          "That ESPN league is not connected to this Draft Genie account. Connect it first, then re-open the draft room.",
        ),
        cors,
      );
    }

    // Refused rather than silently corrected. A tap whose body disagrees with
    // its own connection is either misconfigured or lying, and both are worth
    // hearing about — the same 403 either way, because the distinction is not
    // the sender's business.
    if (
      body.league.espnLeagueId !== connection.espn_league_id ||
      body.league.season !== connection.season
    ) {
      return withCors(
        jsonError(
          403,
          "not_your_league",
          "That ESPN league is not connected to this Draft Genie account. Connect it first, then re-open the draft room.",
        ),
        cors,
      );
    }

    // FR-006a enforced at the BOUNDARY, not only at the source. The tap filters
    // before sending, but a compromised or buggy tap must not be able to write
    // identifiers into our store — so we re-assert it here and reject loudly.
    const wire = JSON.stringify(body.messages);
    if (GUID_ON_WIRE.test(wire) || /https?:\/\//.test(wire)) {
      logError("tap batch rejected: payload carried an identifier or URL", new Error("privacy_violation"));
      return withCors(
        jsonError(400, "payload_not_clean", "Relayed messages must contain numeric identifiers only."),
        cors,
      );
    }

    // Bind against the SAME source that verification reads — the header. This
    // used to bind `body.install`, so a token could be bound by one field and
    // checked against another; they coincide only because the shipped tap
    // happens to send the same value in both, and /status has no body at all.
    await touchPairing(c.env.DB, verified.pairingId, installHeader, at);

    // FR-010 / FR-012: ordering is (install, session, seq); duplicates are
    // expected and are not
    // an error — the receiver deduplicates on pick identity.
    const acceptedThrough = body.messages.reduce((max, m) => Math.max(max, m.seq), -1);
    const kinds = body.messages.reduce<Record<string, number>>((acc, m) => {
      acc[m.kind] = (acc[m.kind] ?? 0) + 1;
      return acc;
    }, {});
    logInfo(`tap batch: connection=${connection.id} n=${body.messages.length} kinds=${JSON.stringify(kinds)}`);

    // Retain it. Without this a live draft relays perfectly and leaves nothing
    // behind — which is exactly what happened on the first real run.
    if (body.messages.length > 0) {
      await retainBatch(
        c.env.DB,
        {
          accountId: verified.accountId,
          connectionId: connection.id,
          // From the VERIFIED row, never the body — see the check above. The
          // 403 and this are deliberately two controls: if one is ever relaxed,
          // the other still holds.
          espnLeagueId: connection.espn_league_id,
          season: connection.season,
          installId: body.install,
          sessionId: body.session,
          firstSeq: body.messages[0]!.seq,
          lastSeq: acceptedThrough,
          kinds: JSON.stringify(kinds),
          messages: body.messages,
        },
        at,
      );
    }

    // 005 FR-007h — NUDGE AFTER THE ACK, never before it, and never inside it.
    //
    // The ordering is the whole design. The tap discards its buffer only on
    // `accepted_through`, so the ack is a durability boundary: it must follow
    // the `retainBatch` write above, and it must NOT wait on the session. A
    // restarting or migrating Durable Object would otherwise stall the tap's
    // buffer — the outcome FR-008's buffering guarantees exist to prevent.
    //
    // `waitUntil` runs this after the response is sent. The nudge carries no
    // frame data; the session pulls from the log it was just written to. A
    // dropped nudge therefore costs latency, never a pick, and the session's
    // 5 s safety alarm bounds that latency inside SC-001's 10 s ceiling.
    // 013 — RELAYING IS LIVENESS. A tap delivering picks is alive, and counting
    // only the separate `/status` heartbeat meant a tap relaying every twenty
    // seconds was judged dead at forty-five, so the room withheld
    // recommendations while receiving that tap's own picks. Recorded here, on
    // the relayer's row only, and never touching `heartbeat_hidden` — a batch
    // says nothing about whether a tab is backgrounded.
    if (body.messages.length > 0) {
      await recordRelayActivity(c.env.DB, connection.id, at);
    }

    // FR-007g: any frame arms. Cheap and idempotent (reads 001's snapshot).
    //
    // 011: the nudge used to be scheduled separately, right here. It is now
    // chained behind each connection's own arm inside `armLeague`, because
    // ordering became load-bearing the moment sessions other than the relayer's
    // had to be armed — an unarmed session swallows a nudge silently and sets no
    // alarm. Whether to nudge at all is still "did this frame carry anything".
    const ctx = execCtx(c);
    await armLeague(
      c.env,
      connection,
      connection.espn_league_id,
      connection.season,
      at,
      ctx,
      body.messages.length > 0,
    );
    if (!ctx) logInfo("tap batch stored without a nudge; the session's alarm will collect it");

    return withCors(
      Response.json({ accepted_through: acceptedThrough, session_known: true, server_time: at.toISOString() }, { status: 202 }),
      cors,
    );
  });

  app.post("/status", async (c) => {
    const cors = corsHeaders(c.req.header("Origin"));
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return withCors(jsonError(401, "unpaired", "This browser is not linked to Draft Genie."), cors);
    const verified = await verifyPairing(c.env.DB, token, c.req.header("X-Tap-Install") ?? null, now(c.env));
    if (!verified.ok) return withCors(jsonError(401, `pairing_${verified.reason}`, "Re-pair this browser."), cors);
    const parsed = statusBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return withCors(jsonError(400, "invalid_status", "Malformed status report."), cors);
    const body = parsed.data;

    // Same boundary the batch route enforces. `detail` is free-ish text built
    // from wrapper errors and ESPN message fragments, and the draft-room URL
    // carries the owner's SWID as a query parameter — so it is a real path for
    // an identifier to reach the log. The tap scrubs it; this does not trust
    // that, because a privacy control asserted only at the source is asserted
    // once, by the party most likely to be out of date.
    const detail = body.detail ?? "";
    if (GUID_ON_WIRE.test(detail) || /https?:\/\//.test(detail)) {
      return withCors(jsonError(400, "payload_not_clean", "Status detail must not carry identifiers."), cors);
    }

    // 005 FR-007e: liveness. Any status — heartbeat or state change — proves
    // the tap is attached, so both refresh it. Picks do too; this only has to
    // cover the silence between them.
    const at = now(c.env);
    await touchPairing(c.env.DB, verified.pairingId, c.req.header("X-Tap-Install") ?? null, at);

    // FR-007g: a HEARTBEAT arms the session, which is the whole reason a
    // missing tap is visible before the first pick rather than after it.
    if (body.league) {
      const connection = await findConnection(
        c.env.DB,
        verified.accountId,
        body.league.espnLeagueId,
        body.league.season,
      );
      if (connection) {
        // A heartbeat carries no frames, so there is nothing to nudge for.
        await armLeague(c.env, connection, connection.espn_league_id, connection.season, at, execCtx(c), false);
        // `hidden` decides WHICH lapse threshold applies: a background tab's
        // timers throttle to ~1/minute, and one threshold would declare a
        // healthy backgrounded tap dead.
        await recordHeartbeat(
          c.env.DB,
          connection.id,
          { hidden: body.hidden === true, tapState: body.state, tapVersion: body.tapVersion ?? null },
          at,
        );
      }
    }

    logInfo(
      `tap ${body.heartbeat ? "heartbeat" : "status"}: ${body.state}` +
        `${body.hidden ? " (hidden)" : ""}${detail ? ` ${detail}` : ""}`,
    );
    return withCors(new Response(null, { status: 204 }), cors);
  });

  return app;
}

/**
 * Pairing management — SESSION authenticated, so this is mounted AFTER the
 * /api/* middleware, unlike the tap-facing routes above which carry their own
 * bearer credential.
 */
export function pairingRoutes() {
  const app = new Hono<AppContext>();

  app.get("/", async (c) => {
    const rows = await listPairings(c.env.DB, c.get("accountId"));
    return Response.json({
      pairings: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        expires_at: r.expires_at,
        revoked: r.revoked_at !== null,
        bound: r.install_id !== null,
      })),
    });
  });

  // 011 US3 REMOVED `POST /api/tap-pairings`.
  //
  // It returned a raw 180-day bearer in a JSON body to page JavaScript, which
  // rendered it into the DOM — readable by any same-origin script, with no race
  // to win. Credentials are now minted only by the enablement redeem, which
  // requires a preimage the page never holds.
  //
  // Existing pairings keep working until they expire or are revoked; nobody is
  // cut off mid-season by this removal.

  app.get("/captures", async (c) => {
    return Response.json({ captures: await summariseBatches(c.env.DB, c.get("accountId")) });
  });

  app.delete("/:id", async (c) => {
    const ok = await revokePairing(c.env.DB, c.get("accountId"), c.req.param("id"), now(c.env));
    if (!ok) return jsonError(404, "not_found", "No such pairing.");
    return new Response(null, { status: 204 });
  });

  return app;
}

function withCors(res: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
