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
  // Stamp `received_at` AS LATE AS POSSIBLE — here, immediately before the
  // insert — rather than carrying the handler's entry time.
  //
  // 005's feed cursor is a high-water mark over `(received_at, id)`, so a row
  // that commits with a timestamp EARLIER than one the session has already
  // read is never read again: a pick lost behind a 202. The handler stamps its
  // clock three D1 round-trips before this insert, and two concurrent batches
  // can easily reorder across that gap. Narrowing the window to a single
  // statement does not make it impossible, but it removes the part that was
  // both large and avoidable. The residual is bounded by the session's
  // re-read on rebuild.
  const receivedAt = new Date(Math.max(now.getTime(), Date.now())).toISOString();
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
      receivedAt,
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
  /**
   * NO `installId` / `sessionId`. They identify the relayer's DEVICE, nothing
   * downstream reads them, and under fan-out they would be one manager's stable
   * GUIDs crossing into another manager's session. Removing them is what makes
   * "no relayer identity in a delivered view" (FR-003, SC-003) true by
   * construction instead of by nobody having used them yet.
   */
  firstSeq: number;
  lastSeq: number;
  messages: unknown[];
}

/**
 * 011 Phase 3 — the reader's entitlement, written into the query.
 *
 * Every league-scoped read of the frame log carries this. It answers one
 * question in SQL: *may the connection asking actually have this league's
 * frames?* Two conditions, and both must hold:
 *
 *   1. the asking connection is FOR this league and season; and
 *   2. its team was matched automatically — ESPN's own owner list contained the
 *      account's SWID (`identifyMyTeam`, 001 FR-014).
 *
 * (2) is the one that matters. A league id is guessable and connecting proves
 * nothing, so "holds a connection row" is not membership. `'manual'` means the
 * user picked a team from a list after the automatic match failed; that is a
 * usable answer for one's own league and NOT evidence of belonging to it.
 *
 * It is a subquery rather than a check in TypeScript on purpose. This is the
 * same argument the ingest makes about ownership: a boundary enforced by the
 * query cannot be forgotten at a call site, and a caller who omits the reader
 * gets a compile error rather than an open door. It is also why entitlement is
 * never inferred from row counts — that mistake has been made here before.
 */
const ENTITLED = `EXISTS (
        SELECT 1 FROM league_connections c
         WHERE c.id = ?
           AND c.espn_league_id = tap_batches.espn_league_id
           AND c.season = tap_batches.season
           AND c.team_match_source = 'auto'
      )`;

/** Who is asking. Not the owner of the rows — the owner of the QUESTION. */
export interface FeedScope {
  /** The asking manager's connection. Entitlement is checked against it. */
  readerConnectionId: string;
  espnLeagueId: string;
  season: number;
}

/**
 * Batches strictly after `cursor`, oldest first — for the whole LEAGUE.
 *
 * Deliberately crosses accounts, and is one of only two places that does (the
 * other is `listConnectionsForLeague`). A league's draft picks are shared among
 * that league's managers — ratified in the constitution on 2026-08-06 — because
 * every manager is already watching the same ESPN draft room. What stays
 * per-account is PERSPECTIVE: which team is mine, my settings, my preferred
 * list. None of that is read here.
 *
 * The caller must never use a row's `account_id`, `install_id` or `session_id`
 * to decide anything — those identify the relayer, and FR-003/SC-003 forbid a
 * relayer's identity reaching a delivered view. They are not selected at all.
 *
 * Backed by `idx_tap_batches_league_all (espn_league_id, season, received_at,
 * id)` — migration 0010, added for exactly this query. The older
 * `idx_tap_batches_league` leads with `account_id` and cannot serve it.
 */
export async function readBatchesAfter(
  db: D1Database,
  scope: FeedScope,
  cursor: FeedCursorRow | null,
  limit = 200,
): Promise<FeedBatchRow[]> {
  // `install_id` and `session_id` are NOT selected. They are another manager's
  // stable per-device identifiers, `foldBatches` never reads them, and not
  // fetching them makes SC-003 structural rather than incidental.
  const sql = cursor
    ? `SELECT id, received_at, first_seq, last_seq, messages_json
         FROM tap_batches
        WHERE espn_league_id = ? AND season = ?
          AND (received_at > ? OR (received_at = ? AND id > ?))
          AND ${ENTITLED}
        ORDER BY received_at ASC, id ASC
        LIMIT ?`
    : `SELECT id, received_at, first_seq, last_seq, messages_json
         FROM tap_batches
        WHERE espn_league_id = ? AND season = ?
          AND ${ENTITLED}
        ORDER BY received_at ASC, id ASC
        LIMIT ?`;

  const stmt = cursor
    ? db
        .prepare(sql)
        .bind(
          scope.espnLeagueId, scope.season,
          cursor.receivedAt, cursor.receivedAt, cursor.id,
          scope.readerConnectionId, limit,
        )
    : db.prepare(sql).bind(scope.espnLeagueId, scope.season, scope.readerConnectionId, limit);

  const r = await stmt.all<{
    id: string;
    received_at: string;
    first_seq: number;
    last_seq: number;
    messages_json: string;
  }>();

  return (r.results ?? []).map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
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

/**
 * The newest batch in the log for this scope, as a cursor — or null if empty.
 *
 * 011 T042: a reset needs somewhere to stand. Clearing the session's cursor
 * rewinds it to the start of the log, and the log deliberately OUTLIVES a reset
 * (FR-029, capture history is never destroyed) — so the next pump would
 * faithfully re-import the draft the reset just discarded. That is the
 * 2026-08-06 "room is loaded with a previous draft" failure, arriving from
 * inside instead of from a stale tab.
 *
 * Same keyset ordering AND the same league scope as `readBatchesAfter` — a
 * floor computed over a narrower set than the reads it bounds is not a floor.
 * Under fan-out that matters: a floor built from the viewer's own rows would sit
 * below a leaguemate's earlier batches, and the next pump would import them.
 */
export async function latestBatchCursor(
  db: D1Database,
  scope: FeedScope,
): Promise<FeedCursorRow | null> {
  const row = await db
    .prepare(
      `SELECT id, received_at
         FROM tap_batches
        WHERE espn_league_id = ? AND season = ?
          AND ${ENTITLED}
        ORDER BY received_at DESC, id DESC
        LIMIT 1`,
    )
    .bind(scope.espnLeagueId, scope.season, scope.readerConnectionId)
    .first<{ id: string; received_at: string }>();
  return row ? { receivedAt: row.received_at, id: row.id } : null;
}
