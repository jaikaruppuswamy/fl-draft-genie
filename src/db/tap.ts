// 010 T032 — pairing credentials for the browser companion.
//
// The token is never stored, only its hash (001's credential pattern). Scope is
// PER USER; the league travels per message and is verified against the
// account's own connections at ingest — which is how 005 FR-007d's
// per-connection scoping and 010 FR-014's one-install-serves-all-leagues are
// the same rule rather than a contradiction.

import { sha256Hex } from "./client";

export interface TapPairingRow {
  id: string;
  account_id: string;
  install_id: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

/** FR-014a: a stated lifetime, not an indefinite credential. */
export const PAIRING_TTL_DAYS = 180;

export async function issuePairing(
  db: D1Database,
  accountId: string,
  now: Date,
): Promise<{ token: string; row: TapPairingRow }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID();
  const expires = new Date(now.getTime() + PAIRING_TTL_DAYS * 86_400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO tap_pairings (id, account_id, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, accountId, await sha256Hex(token), now.toISOString(), expires)
    .run();
  return {
    token,
    row: {
      id,
      account_id: accountId,
      install_id: null,
      created_at: now.toISOString(),
      last_used_at: null,
      expires_at: expires,
      revoked_at: null,
    },
  };
}

export type VerifyResult =
  | { ok: true; accountId: string; pairingId: string }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "wrong_install" };

export async function verifyPairing(
  db: D1Database,
  token: string,
  installId: string | null,
  now: Date,
): Promise<VerifyResult> {
  const row = await db
    .prepare(`SELECT * FROM tap_pairings WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<TapPairingRow>();
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at <= now.toISOString()) return { ok: false, reason: "expired" };
  // Bound on first use, so one token is not silently shared across machines.
  if (row.install_id && installId && row.install_id !== installId) {
    return { ok: false, reason: "wrong_install" };
  }
  return { ok: true, accountId: row.account_id, pairingId: row.id };
}

export async function touchPairing(
  db: D1Database,
  pairingId: string,
  installId: string | null,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tap_pairings
          SET last_used_at = ?, install_id = COALESCE(install_id, ?)
        WHERE id = ?`,
    )
    .bind(now.toISOString(), installId, pairingId)
    .run();
}

export async function revokePairing(db: D1Database, accountId: string, pairingId: string, now: Date): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE tap_pairings SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL`)
    .bind(now.toISOString(), pairingId, accountId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listPairings(db: D1Database, accountId: string): Promise<TapPairingRow[]> {
  const r = await db
    .prepare(`SELECT * FROM tap_pairings WHERE account_id = ? ORDER BY created_at DESC`)
    .bind(accountId)
    .all<TapPairingRow>();
  return r.results ?? [];
}
