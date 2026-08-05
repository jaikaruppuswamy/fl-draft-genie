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
  /** 001's stored roster shape; `starting_slots` + `bench_slots` per team. */
  roster_json?: string | null;
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
  const totalPicks = totalPicksFrom(teamCount, i.snapshot?.roster_json ?? null);

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

/**
 * How many picks a full draft has: teams × roster spots.
 *
 * THIS USED TO BE HARDCODED TO 0, which made completion unreachable in
 * production — the session never finished, never wrote `complete`, and
 * therefore never archived. The archive tests passed because they armed with
 * an explicit total that nothing in production supplied.
 *
 * ESPN does not publish a round count directly, but 001 already stores the
 * roster shape, and every roster spot is one pick. Returns 0 when either input
 * is missing: 0 means "not yet known" and keeps completion unreachable, which
 * is the safe direction — a false `complete` stops the relay mid-draft, while a
 * missing one only delays the archive until the data arrives.
 *
 * KEEPER LEAGUES draft fewer picks than this, so the count errs HIGH there. The
 * authoritative figure is the ledger's own slot count, which ESPN sends and the
 * tap decodes as `totalSlots` but does not currently relay — relaying it is the
 * better long-term source and is recorded in the 010 backlog.
 */
export function totalPicksFrom(teamCount: number, rosterJson: string | null): number {
  if (teamCount <= 0 || !rosterJson) return 0;
  try {
    const r = JSON.parse(rosterJson) as { starting_slots?: number; bench_slots?: number };
    const spots = Number(r.starting_slots ?? 0) + Number(r.bench_slots ?? 0);
    return spots > 0 ? teamCount * spots : 0;
  } catch {
    return 0;
  }
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
