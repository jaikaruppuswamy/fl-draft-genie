// 005 T037/T038 — turning a connection into an armed session scope (FR-007g).
//
// PURE. The impure half (reading D1, calling the DO) lives at the call sites.
//
// WHY THE SCOPE COMES FROM A SNAPSHOT, NOT A FRESH ESPN CALL: 001's pre-draft
// sync already fetches and stores exactly this — draft type, scheduled time,
// published order, team count — on the 5-minute cron inside the pre-draft
// window. Re-fetching on arm would duplicate that work, and would do it on the
// path a heartbeat takes every 15 seconds, blowing FR-008's rate bound for no
// new information. Gate 0 disproved live PICK visibility; it did not disprove
// these reads, and they are already being made.

import type { SessionScope } from "./session";

export interface SnapshotLike {
  team_count: number;
  draft_json: string | null;
}

interface ParsedDraft {
  type?: string | null;
  supported?: boolean;
  scheduled_at?: string | null;
  order?: number[] | null;
}

export interface ArmingInput {
  accountId: string;
  connectionId: string;
  espnLeagueId: string;
  season: number;
  myTeamId: number | null;
  snapshot: SnapshotLike | null;
}

export interface ArmingResult {
  scope: SessionScope;
  scheduledAt: string | null;
  /** False for a format this feature does not handle (auction, offline). */
  supported: boolean;
}

function parseDraft(json: string | null): ParsedDraft {
  if (!json) return {};
  try {
    return JSON.parse(json) as ParsedDraft;
  } catch {
    return {};
  }
}

/**
 * Build the session scope.
 *
 * Every unknown resolves to a value the session treats as "not yet known"
 * rather than a guess: an empty order (which degrades `orderTrust` to
 * `unknown` and suppresses turn events) and a zero total (which can never
 * satisfy the completion check). ESPN publishes the order about an hour before
 * the draft, so arming legitimately happens before any of it exists.
 */
export function armingScope(i: ArmingInput): ArmingResult {
  const draft = parseDraft(i.snapshot?.draft_json ?? null);
  const teamCount = i.snapshot?.team_count ?? 0;
  const order = draft.order && draft.order.length > 0 ? draft.order : [];
  // A round count is not published directly; it follows from the roster size,
  // which 001 stores separately. Until a ledger states the real total, 0 keeps
  // completion unreachable — deliberately, since a false "complete" stops the
  // relay and is the worse error.
  const totalPicks = 0;

  return {
    scope: {
      accountId: i.accountId,
      connectionId: i.connectionId,
      espnLeagueId: i.espnLeagueId,
      season: i.season,
      myTeamId: i.myTeamId,
      order,
      totalPicks,
    },
    scheduledAt: draft.scheduled_at ?? null,
    // Absent draft settings are NOT "unsupported" — they are "not published
    // yet". Marking them unsupported would abort a session before ESPN has
    // said anything about the draft at all.
    supported: draft.type === undefined || draft.type === null ? true : draft.supported === true,
  };
}

/** How long an armed session may wait before it aborts itself. */
export const ARMED_DEADLINE_MS = 6 * 60 * 60 * 1000;

/**
 * Has an armed session waited past its deadline? (FR-002, postponed drafts)
 *
 * A session stuck `armed` keeps its alarm scheduled and bills indefinitely —
 * ~11,000 GB-s/day. The deadline is absolute rather than a heartbeat so a
 * postponed draft cannot hold one open forever; re-arming happens on its own
 * when a league re-sync publishes a different `draft_at`.
 */
export function armedDeadlinePassed(scheduledAt: string | null, armedAt: string | null, now: number): boolean {
  const anchor = scheduledAt ?? armedAt;
  if (!anchor) return false;
  const t = Date.parse(anchor);
  return Number.isFinite(t) && now - t > ARMED_DEADLINE_MS;
}
