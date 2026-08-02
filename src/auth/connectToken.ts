// Short-lived signed token carrying the 409 team_choice_required state
// (contracts/api.md POST /api/leagues/connect/complete). No server-side rows.

import type { Env } from "../env";

const TTL_MS = 10 * 60 * 1000;

export interface ConnectClaim {
  account_id: string;
  league_id: string;
  season: number;
  exp: number;
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string | null {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

async function key(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`connect:${env.SESSION_SECRET}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createConnectToken(
  env: Env,
  claim: Omit<ConnectClaim, "exp">,
  now: Date,
): Promise<string> {
  const payload = b64url(JSON.stringify({ ...claim, exp: now.getTime() + TTL_MS }));
  const sig = await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(payload));
  return `${payload}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
}

export async function verifyConnectToken(
  env: Env,
  token: string,
  now: Date,
): Promise<ConnectClaim | null> {
  const [payload, sigB64] = token.split(".");
  if (!payload || !sigB64) return null;
  const sigRaw = b64urlDecode(sigB64);
  if (sigRaw === null) return null;
  const sig = Uint8Array.from(sigRaw, (ch) => ch.charCodeAt(0));
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(env),
    sig as BufferSource,
    new TextEncoder().encode(payload),
  );
  if (!ok) return null;
  const json = b64urlDecode(payload);
  if (json === null) return null;
  try {
    const claim = JSON.parse(json) as ConnectClaim;
    if (claim.exp <= now.getTime()) return null;
    return claim;
  } catch {
    return null;
  }
}
