// Passwordless sign-in: one row per request carrying both a 6-digit code and a
// magic-link token (hashed at rest, 10-min expiry, single-use, ≤3 outstanding
// per email, ≤5 verify attempts per token). See data-model.md `login_tokens`.

import type { Env } from "../env";
import { sha256Hex } from "../db/client";
import {
  consumeToken,
  countOutstandingTokens,
  findUsableTokenByLinkHash,
  findUsableTokensByEmail,
  incrementAttempts,
} from "../db/loginTokens";
import { insertLoginToken } from "../db/loginTokens";
import { createAccount, findAccountByEmail, touchLogin, type AccountRow } from "../db/accounts";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_OUTSTANDING = 3;

export type IssueResult =
  | { ok: true; code: string; linkToken: string }
  | { ok: false; error: "rate_limited" };

export async function issueLoginToken(env: Env, email: string, now: Date): Promise<IssueResult> {
  if ((await countOutstandingTokens(env.DB, email, now)) >= MAX_OUTSTANDING) {
    return { ok: false, error: "rate_limited" };
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  const linkBytes = crypto.getRandomValues(new Uint8Array(16));
  const linkToken = [...linkBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await insertLoginToken(
    env.DB,
    email,
    await sha256Hex(code),
    await sha256Hex(linkToken),
    new Date(now.getTime() + TOKEN_TTL_MS),
    now,
  );
  return { ok: true, code, linkToken };
}

export type VerifyResult = { ok: true; account: AccountRow } | { ok: false; error: "invalid_code" };

async function loginAccount(env: Env, email: string, now: Date): Promise<AccountRow> {
  const existing = await findAccountByEmail(env.DB, email);
  if (existing) {
    await touchLogin(env.DB, existing.id, now);
    return existing;
  }
  // First successful verify creates the account (contracts/api.md).
  return createAccount(env.DB, email, now);
}

export async function verifyCode(
  env: Env,
  email: string,
  code: string,
  now: Date,
): Promise<VerifyResult> {
  const codeHash = await sha256Hex(code.trim());
  const candidates = await findUsableTokensByEmail(env.DB, email, now);
  for (const token of candidates) {
    if (token.code_hash === codeHash) {
      await consumeToken(env.DB, token.id, now);
      return { ok: true, account: await loginAccount(env, email, now) };
    }
  }
  // Burn an attempt on every live token for this email so guessing is bounded.
  for (const token of candidates) await incrementAttempts(env.DB, token.id);
  return { ok: false, error: "invalid_code" };
}

export async function verifyMagicLink(
  env: Env,
  linkToken: string,
  now: Date,
): Promise<VerifyResult> {
  const token = await findUsableTokenByLinkHash(env.DB, await sha256Hex(linkToken.trim()), now);
  if (!token) return { ok: false, error: "invalid_code" };
  await consumeToken(env.DB, token.id, now);
  return { ok: true, account: await loginAccount(env, token.email, now) };
}
