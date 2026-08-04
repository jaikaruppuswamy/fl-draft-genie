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
import { logInfo } from "./logging";
import { touchPairing, verifyPairing } from "../db/tap";
import { getConnectionById } from "../db/leagues";

/** The tap runs on ESPN's origin; nothing else needs these routes. */
const ALLOWED_ORIGINS = new Set(["https://fantasy.espn.com"]);

/** Wire-contract versions this Worker understands. A tap outside this set gets
 *  409 so it can tell the user to update, rather than being misread. */
const SUPPORTED_CONTRACT_VERSIONS = new Set([1]);

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
  connectionId: z.string().min(1),
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
    // FR-007d). The lookup is itself account-scoped, so ownership is enforced
    // by the query rather than by a comparison we could forget.
    const connection = await getConnectionById(c.env.DB, verified.accountId, body.connectionId);
    if (!connection) {
      return withCors(jsonError(403, "not_your_league", "That league is not connected to this account."), cors);
    }

    await touchPairing(c.env.DB, verified.pairingId, body.install, at);

    // Ordering is (install, session, seq); duplicates are expected and are not
    // an error — the receiver deduplicates on pick identity.
    const acceptedThrough = body.messages.reduce((max, m) => Math.max(max, m.seq), -1);
    const kinds = body.messages.reduce<Record<string, number>>((acc, m) => {
      acc[m.kind] = (acc[m.kind] ?? 0) + 1;
      return acc;
    }, {});
    logInfo(`tap batch: connection=${body.connectionId} n=${body.messages.length} kinds=${JSON.stringify(kinds)}`);

    // 005 owns applying these to a draft session. Until it lands, the ingest
    // validates, authorises and acknowledges — which is exactly the seam the
    // two features were split at.
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
    const body = (await c.req.json().catch(() => ({}))) as { state?: string; detail?: string };
    logInfo(`tap status: ${String(body.state)} ${String(body.detail ?? "")}`.trim());
    return withCors(new Response(null, { status: 204 }), cors);
  });

  return app;
}

function withCors(res: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
