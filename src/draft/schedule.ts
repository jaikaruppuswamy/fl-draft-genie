// 005 T013 — ESPN read cadence and the back-off ladder (FR-008).
//
// PURE. No platform imports.
//
// This is all that survives of the retired four-tier poll cadence. It governs
// ESPN READS ONLY — draft type, scheduled time, published order, teams, and the
// `inProgress`/`drafted` flags. **No ESPN request sits on the pick path**:
// picks arrive from the tap, and Gate 0 proved no read API can see a draft in
// progress.
//
// That is why the documented rate bound dropped from 25/min to 5/min. The old
// number was sized around a 3 s poll tier that no longer exists; stating it now
// would document headroom the design cannot use.

/** FR-008's documented ceiling, asserted structurally by SC-008. */
export const MAX_ESPN_REQUESTS_PER_MINUTE = 5;

/** Slow observation of the `inProgress`/`drafted` flags while a room is open. */
export const LIVE_FLAG_POLL_MS = 60_000;

/** Pre-draft refresh while armed, waiting for the order to be published. */
export const ARMED_POLL_MS = 60_000;

/** An armed session self-aborts here; a stuck one burns ~11,000 GB-s/day. */
export const ARMED_DEADLINE_MS = 6 * 60 * 60 * 1000;

const LADDER_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export type EspnErrorKind = "espn_unreachable" | "espn_rejected" | "league_not_found";

export interface BackoffInput {
  consecutiveErrors: number;
  lastError: EspnErrorKind | null;
}

/**
 * Next ESPN read delay, or `null` to stop entirely.
 *
 * `league_not_found` is terminal rather than laddered. A 404 does not become a
 * 200 by waiting, and a session that keeps retrying one hammers ESPN forever
 * for a league that no longer exists — the opposite of Constitution VI's
 * respectful posture. `espn_rejected` (bad credentials) DOES ladder, because
 * the owner can fix it mid-draft by re-entering cookies.
 */
export function nextEspnDelayMs(i: BackoffInput): number | null {
  if (i.lastError === "league_not_found") return null;
  if (i.consecutiveErrors <= 0) return null;
  const idx = Math.min(i.consecutiveErrors - 1, LADDER_MS.length - 1);
  return LADDER_MS[idx]!;
}

export type SessionStatus =
  | "unsupported"
  | "idle"
  | "armed"
  | "live"
  | "not_receiving"
  | "degraded"
  | "complete"
  | "aborted";

export interface CadenceInput extends BackoffInput {
  status: SessionStatus;
}

/**
 * When should this session next read ESPN? `null` means never again.
 *
 * A completed, aborted or unsupported session schedules NOTHING — that plus the
 * armed deadline is what keeps a postponed draft from billing indefinitely.
 */
export function nextEspnReadMs(i: CadenceInput): number | null {
  if (i.status === "complete" || i.status === "aborted" || i.status === "unsupported") return null;
  // Terminal errors stop the session outright. Checked BEFORE the ladder,
  // because `nextEspnDelayMs` returns null for both "no back-off needed" and
  // "never retry" — falling through on that null would resume the normal
  // cadence and hammer a 404 forever, which is precisely what the terminal
  // rule exists to prevent.
  if (i.lastError === "league_not_found") return null;
  const backoff = nextEspnDelayMs(i);
  if (backoff !== null) return backoff;
  if (i.status === "armed") return ARMED_POLL_MS;
  if (i.status === "live" || i.status === "not_receiving" || i.status === "degraded") return LIVE_FLAG_POLL_MS;
  return null; // idle: nothing to watch until a tap arms it (FR-007g)
}
