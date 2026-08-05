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
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "wrong_install" | "missing_install" };

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
  //
  // The install id is REQUIRED, not merely compared when present. The previous
  // form was `row.install_id && installId && row.install_id !== installId`,
  // which short-circuits to "ok" the moment `installId` is null — so a caller
  // that simply OMITTED the `X-Tap-Install` header skipped the binding check
  // entirely and a captured token worked from any machine. The control that
  // bounds a stolen token's blast radius was disabled by leaving out a header.
  //
  // An absent id also means an unbound token can never become bound, so the
  // gap does not close by itself with use.
  if (!installId) return { ok: false, reason: "missing_install" };
  if (row.install_id && row.install_id !== installId) {
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

/** One accepted relay batch, retained so a live draft leaves a corpus behind
 *  (010 T047). Contents are numeric-only by the time they get here. */
export interface RetainedBatch {
  accountId: string;
  connectionId: string;
  espnLeagueId: string;
  season: number;
  installId: string;
  sessionId: string;
  firstSeq: number;
  lastSeq: number;
  kinds: string;
  messages: unknown[];
}

export async function retainBatch(db: D1Database, b: RetainedBatch, now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      b.accountId,
      b.connectionId,
      b.espnLeagueId,
      b.season,
      b.installId,
      b.sessionId,
      now.toISOString(),
      b.firstSeq,
      b.lastSeq,
      b.messages.length,
      b.kinds,
      JSON.stringify(b.messages),
    )
    .run();
}

export interface BatchSummary {
  espn_league_id: string;
  season: number;
  session_id: string;
  batches: number;
  messages: number;
  first_at: string;
  last_at: string;
}

export async function summariseBatches(db: D1Database, accountId: string): Promise<BatchSummary[]> {
  const r = await db
    .prepare(
      `SELECT espn_league_id, season, session_id,
              COUNT(*) AS batches, SUM(message_count) AS messages,
              MIN(received_at) AS first_at, MAX(received_at) AS last_at
         FROM tap_batches WHERE account_id = ?
        GROUP BY espn_league_id, season, session_id
        ORDER BY MAX(received_at) DESC`,
    )
    .bind(accountId)
    .all<BatchSummary>();
  return r.results ?? [];
}

// --- 005 feed: the keyset cursor read (FR-007h) ------------------------------
//
// The DraftSession PULLS from this log rather than having frames pushed into
// it. See specs/005-draft-monitor/plan.md; the short version is that the tap
// discards its buffer only on `accepted_through`, which makes the ack a
// durability boundary — so the ingest writes here, acks, and only THEN nudges.
//
// KEYSET, not offset: a batch inserted while a read is in flight shifts an
// offset window and silently skips a row. Anchoring on `(received_at, id)` is
// stable under concurrent inserts, and the pair is a total order because
// autodraft can land two batches in the same millisecond.

export interface FeedCursorRow {
  receivedAt: string;
  id: string;
}

export interface FeedBatchRow {
  id: string;
  receivedAt: string;
  installId: string;
  sessionId: string;
  firstSeq: number;
  lastSeq: number;
  messages: unknown[];
}

/**
 * Batches strictly after `cursor`, oldest first.
 *
 * Backed by `idx_tap_batches_league (account_id, espn_league_id, season,
 * received_at)`, so no migration was needed to make the session readable.
 */
export async function readBatchesAfter(
  db: D1Database,
  scope: { accountId: string; espnLeagueId: string; season: number },
  cursor: FeedCursorRow | null,
  limit = 200,
): Promise<FeedBatchRow[]> {
  const sql = cursor
    ? `SELECT id, received_at, install_id, session_id, first_seq, last_seq, messages_json
         FROM tap_batches
        WHERE account_id = ? AND espn_league_id = ? AND season = ?
          AND (received_at > ? OR (received_at = ? AND id > ?))
        ORDER BY received_at ASC, id ASC
        LIMIT ?`
    : `SELECT id, received_at, install_id, session_id, first_seq, last_seq, messages_json
         FROM tap_batches
        WHERE account_id = ? AND espn_league_id = ? AND season = ?
        ORDER BY received_at ASC, id ASC
        LIMIT ?`;

  const stmt = cursor
    ? db
        .prepare(sql)
        .bind(scope.accountId, scope.espnLeagueId, scope.season, cursor.receivedAt, cursor.receivedAt, cursor.id, limit)
    : db.prepare(sql).bind(scope.accountId, scope.espnLeagueId, scope.season, limit);

  const r = await stmt.all<{
    id: string;
    received_at: string;
    install_id: string;
    session_id: string;
    first_seq: number;
    last_seq: number;
    messages_json: string;
  }>();

  return (r.results ?? []).map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
    installId: row.install_id,
    sessionId: row.session_id,
    firstSeq: row.first_seq,
    lastSeq: row.last_seq,
    messages: safeParseMessages(row.messages_json),
  }));
}

/** A corrupt row must not take the whole draft down mid-session. */
function safeParseMessages(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
