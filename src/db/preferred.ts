// 006 T006 — the preferred-player list.
//
// EVERY query filters on `account_id` IN THE SQL (FR-020).
//
// That is not belt-and-braces over a route check; it is instead of one. 005
// established the pattern with `readBatchesAfter`: isolation enforced by the
// query cannot be forgotten at a call site, cannot be bypassed by a new route,
// and cannot regress when someone adds a convenience helper. A comparison in a
// handler has none of those properties.
//
// The constitution's Security & Privacy section names preferred lists
// explicitly — "one user can never see another user's leagues, credentials, or
// preferred lists" — so this is the file where that promise is either kept or
// quietly broken.

import { iso } from "./client";

export interface PreferredRow {
  espn_player_id: number;
  created_at: string;
}

/**
 * The owner's list for one league and season.
 *
 * Ordered by `created_at` then id: FR-017 wants a total order everywhere, and a
 * list that reshuffles between reads makes the page feel broken.
 */
export async function listPreferred(
  db: D1Database,
  accountId: string,
  connectionId: string,
  season: number,
): Promise<PreferredRow[]> {
  const res = await db
    .prepare(
      `SELECT espn_player_id, created_at
         FROM preferred_players
        WHERE account_id = ? AND connection_id = ? AND season = ?
        ORDER BY created_at, espn_player_id`,
    )
    .bind(accountId, connectionId, season)
    .all<PreferredRow>();
  return res.results;
}

/**
 * Idempotent add. Adding a player twice is a no-op, not an error — the page
 * fires this on a click and a double click must not be a failure.
 */
export async function addPreferred(
  db: D1Database,
  accountId: string,
  connectionId: string,
  season: number,
  espnPlayerId: number,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO preferred_players
         (connection_id, account_id, season, espn_player_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(connectionId, accountId, season, espnPlayerId, iso(now))
    .run();
}

/** Idempotent remove. Scoped to the account, so a wrong id cannot delete another's row. */
export async function removePreferred(
  db: D1Database,
  accountId: string,
  connectionId: string,
  season: number,
  espnPlayerId: number,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM preferred_players
        WHERE account_id = ? AND connection_id = ? AND season = ? AND espn_player_id = ?`,
    )
    .bind(accountId, connectionId, season, espnPlayerId)
    .run();
}
