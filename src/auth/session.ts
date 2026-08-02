// Stateless session cookie: base64url(JSON{account_id, exp}) + "." + base64url(HMAC-SHA256).
// No server-side session state (research.md §4).

import type { Env } from "../env";

export const SESSION_COOKIE = "dg_session";
const SESSION_TTL_DAYS = 30;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(env: Env, accountId: string, now: Date): Promise<string> {
  const payload = { account_id: accountId, exp: now.getTime() + SESSION_TTL_DAYS * 86400_000 };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    new TextEncoder().encode(payloadB64),
  );
  return `${payloadB64}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  env: Env,
  token: string,
  now: Date,
): Promise<string | null> {
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  const sig = b64urlDecode(sigB64);
  if (!sig) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    sig as BufferSource,
    new TextEncoder().encode(payloadB64),
  );
  if (!ok) return null;
  const payloadBytes = b64urlDecode(payloadB64);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      account_id?: string;
      exp?: number;
    };
    if (typeof payload.account_id !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= now.getTime()) return null;
    return payload.account_id;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(token: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 86400}${secure}`;
}

export function clearSessionCookieHeader(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
