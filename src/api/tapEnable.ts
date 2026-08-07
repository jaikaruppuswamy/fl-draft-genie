// 011 US3 — the one-click enablement endpoints.
//
// TWO ROUTERS, and they mount on OPPOSITE SIDES of the session middleware.
// Getting that backwards is trap #1 in `src/api/tap.ts`: a redeem mounted
// behind the middleware returns 401 no matter how correct the preimage is,
// because the userscript has no session cookie and must not have one.
//
//   claim  — the PAGE calls it, session-authenticated. Sends a HASH.
//   redeem — the SCRIPT calls it, unauthenticated by cookie. Sends the PREIMAGE.
//
// Neither half is sufficient. A claim stolen by a same-origin script is
// useless without the nonce, which only the extension ever held. A nonce is
// useless without a claim minted under somebody's session.
//
// This is the whole reason the flow replaces the old one: `POST /api/tap-pairings`
// returned a 180-day bearer to page JavaScript, which then rendered it into the
// DOM. FR-017 forbids the owner handling a credential; that flow required it.

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { now } from "../env";
import { SUPPORTED_CONTRACT_VERSIONS } from "./tap";
import { consumeEnableClaim, createEnableClaim, issuePairing, verifyPairing } from "../db/tap";

/** 64 hex characters: a sha256, and nothing else shaped like anything. */
const HEX_64 = /^[0-9a-f]{64}$/;

const claimBody = z.object({
  commit: z.string().regex(HEX_64),
  v: z.number().int().optional(),
});

const redeemBody = z.object({
  claim: z.string().min(1).max(64),
  nonce: z.string().regex(HEX_64),
  v: z.number().int().optional(),
});

/**
 * MOUNT AFTER the `/api/*` session middleware.
 *
 * The account comes from the session and never from the body — the page cannot
 * ask for a claim on somebody else's behalf, because it cannot say whose.
 */
export function enableClaimRoutes() {
  const app = new Hono<AppContext>();

  app.post("/claim", async (c) => {
    const parsed = claimBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "invalid_claim", "Malformed enablement request.");

    // Version-checked HERE, before anything is minted, so a stale script is
    // told to update now rather than discovering it when its first batch 409s
    // in the middle of a draft.
    if (parsed.data.v !== undefined && !SUPPORTED_CONTRACT_VERSIONS.has(parsed.data.v)) {
      return jsonError(409, "unsupported_version", "This version of the draft tap is too old. Update it, then try again.");
    }

    const claimId = await createEnableClaim(c.env.DB, c.get("accountId"), parsed.data.commit, now(c.env));
    // An opaque handle. Not a credential — it cannot be redeemed without the
    // preimage, which this response does not contain and the page never had.
    return Response.json({ claim_id: claimId }, { status: 201 });
  });

  return app;
}

/**
 * MOUNT BEFORE the `/api/*` session middleware, and before `/api/tap`.
 *
 * Hono matches in order, so `/api/tap/enable` has to be registered ahead of the
 * broader `/api/tap` router or this never runs.
 */
export function enableRedeemRoutes() {
  const app = new Hono<AppContext>();

  app.post("/redeem", async (c) => {
    const parsed = redeemBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "invalid_redeem", "Malformed enablement request.");
    if (parsed.data.v !== undefined && !SUPPORTED_CONTRACT_VERSIONS.has(parsed.data.v)) {
      return jsonError(409, "unsupported_version", "This version of the draft tap is too old. Update it, then try again.");
    }

    const at = now(c.env);
    const claim = await consumeEnableClaim(c.env.DB, parsed.data.claim, parsed.data.nonce, at);
    if (!claim.ok) {
      // The reason is returned so the page can say what to do (FR-021). None of
      // these names a credential, and none distinguishes "no such claim" from
      // "not yours" — there is no such thing as "not yours" here, because the
      // preimage is the only thing that identifies the holder.
      return jsonError(400, claim.reason, "That enablement request could not be completed.");
    }

    // FR-020 — re-acknowledging is safe and must not interrupt a relay in
    // progress. If this browser already holds a working credential for the same
    // account, say so and mint NOTHING. Evidence, not a promise: the script
    // presents the bearer it holds and the server verifies it.
    const auth = c.req.header("Authorization") ?? "";
    const held = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (held) {
      const existing = await verifyPairing(c.env.DB, held, c.req.header("X-Tap-Install") ?? null, at);
      if (existing.ok && existing.accountId === claim.accountId) {
        return Response.json({ status: "already_enabled" });
      }
    }

    const { token, row } = await issuePairing(c.env.DB, claim.accountId, at);
    // The credential goes to the EXTENSION and nowhere else. It is not rendered,
    // not returned to the page, and not recoverable afterwards — only its hash
    // is stored.
    return Response.json({ status: "enabled", token, pairing_id: row.id, expires_at: row.expires_at });
  });

  return app;
}
