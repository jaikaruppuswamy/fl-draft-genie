// 005 T015 — the reducer. `(state, observation) → (state, events[])`
//
// PURE. No platform imports, no clock, no I/O. This is the feature's core, and
// keeping it here rather than inside the Durable Object is what makes FR-021
// (offline replay) true by construction — SC-010 replays the committed corpus
// through this function with no Worker running at all.
//
// FOUR RULES, each learned rather than assumed:
//
//  1. IDENTITY IS THE PLAYER ID (FR-005a). `SELECTED` carries no pick ordinal,
//     so the overall number is DERIVED from the frontier for incremental picks
//     and taken from the ledger where present. Field 3 is NOT the round — the
//     independent oracle disproved that at 5/70 — so it is carried opaquely and
//     never used to order anything.
//
//  2. THE LEDGER IS AUTHORITATIVE. It is a full snapshot, arrives first in any
//     session, and is what recovers picks the incremental stream dropped: in
//     the observed draft 3 of 72 picks existed ONLY in a ledger. The union of
//     both sources is the draft; either alone is incomplete.
//
//  3. NO-OP MUST BE FREE. Re-reading a batch, or a safety-alarm sweep finding
//     the cursor already current, must produce ZERO events and an unchanged
//     state. Duplicates are expected (FR-010) — two tabs relay the same draft —
//     and they collapse on identity, not on arrival order.
//
//  4. A CORRECTION BUMPS THE REVISION. Exactly-once is scoped PER REVISION, so
//     a correction replays the affected turns under the new number and
//     consumers dedupe on (revision, kind, overall), reading a bump as "rewind
//     and re-apply".

import { picksUntilTurn, teamAt, orderTrust, type OrderTrust } from "./snake";
import type { Observation, PickObservation } from "./feed";

export interface Pick {
  overall: number;
  teamId: number;
  playerId: number;
  /** Unresolved protocol field. Carried, never interpreted. */
  slot3: number;
  observedAt: string;
  /** Stamps compare only within one epoch — the tap re-anchors across sleep. */
  epoch: number;
}

export interface DraftState {
  revision: number;
  /** Monotonic within an epoch; the client cursor rides on this. */
  seq: number;
  order: number[];
  myTeamId: number | null;
  /** 0 means "not yet known" — never treated as a total. */
  totalPicks: number;
  /** Dense, ascending by `overall`. */
  picks: Pick[];
  /** overall → the revision in which that turn's event last fired. */
  deckFired: Record<number, number>;
  clockFired: Record<number, number>;
  complete: boolean;
}

export type DraftEvent =
  | { kind: "pick_made"; revision: number; overall: number; teamId: number; playerId: number; observedAt: string }
  | { kind: "on_deck"; revision: number; overall: number; picksUntil: number }
  | { kind: "on_the_clock"; revision: number; overall: number; teamId: number }
  | { kind: "draft_complete"; revision: number; totalPicks: number };

export function initialState(over: Partial<DraftState> = {}): DraftState {
  return {
    revision: 0,
    seq: 0,
    order: [],
    myTeamId: null,
    totalPicks: 0,
    picks: [],
    deckFired: {},
    clockFired: {},
    complete: false,
    ...over,
  };
}

/** Lowest pick number not yet made. */
export function frontier(s: DraftState): number {
  return s.picks.length + 1;
}

export function observedMap(s: DraftState): Map<number, number> {
  return new Map(s.picks.map((p) => [p.overall, p.teamId]));
}

export function trust(s: DraftState): OrderTrust {
  return orderTrust(s.order, s.picks.length);
}

/**
 * `on_deck` fires as early as the draft's STRUCTURE allows, at most two picks
 * ahead — never a flat "two ahead".
 *
 * At a snake boundary the owner picks back-to-back, so their second turn can
 * only ever be one pick away; promising two would mean promising an event that
 * cannot exist. The event therefore carries the REAL `picksUntil` (2, 1 or 0)
 * and 006 pre-computes its second pick off `on_the_clock` instead.
 */
const DECK_LEAD = 2;

function sortPicks(picks: Pick[]): Pick[] {
  return [...picks].sort((a, b) => a.overall - b.overall);
}

function toPick(o: PickObservation, overall: number): Pick {
  return {
    overall,
    teamId: o.teamId,
    playerId: o.playerId,
    slot3: o.slot3,
    observedAt: o.observedAt,
    epoch: o.epoch,
  };
}

/** Merge a ledger snapshot, which is authoritative where it speaks. */
function applyLedger(current: Pick[], ledger: PickObservation[]): Pick[] {
  const byOverall = new Map(current.map((p) => [p.overall, p]));
  let nextDerived = current.length + 1;
  for (const o of ledger) {
    // A ledger row without an ordinal is appended in order, same as a frame.
    const overall = o.overallPickNumber ?? nextDerived++;
    const existing = byOverall.get(overall);
    // FIRST-SEEN-WINS on observed_at: a rebuild collapses every pick onto one
    // observation time otherwise, destroying the per-pick timing 008 needs.
    byOverall.set(overall, { ...toPick(o, overall), observedAt: existing?.observedAt ?? o.observedAt });
  }
  return sortPicks([...byOverall.values()]);
}

/** Append incremental picks, collapsing anything already known by identity. */
function applyIncremental(current: Pick[], picks: PickObservation[]): Pick[] {
  const known = new Set(current.map((p) => p.playerId));
  const out = [...current];
  for (const o of picks) {
    if (known.has(o.playerId)) continue; // two tabs, or a replayed batch
    known.add(o.playerId);
    out.push(toPick(o, out.length + 1));
  }
  return sortPicks(out);
}

/** The lowest `overall` whose occupant changed. `null` when nothing did. */
function firstDivergence(before: Pick[], after: Pick[]): number | null {
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i];
    const b = after[i];
    if (!a || !b) return (b ?? a)!.overall;
    if (a.playerId !== b.playerId || a.teamId !== b.teamId) return b.overall;
  }
  return null;
}

/** Was this a pure forward append, or did history change under us? */
function isCorrection(before: Pick[], after: Pick[]): boolean {
  const d = firstDivergence(before, after);
  return d !== null && d <= before.length;
}

export interface ReduceResult {
  state: DraftState;
  events: DraftEvent[];
}

/**
 * Fold one observation into the draft.
 *
 * Returns the SAME state object and an empty event list when nothing changed,
 * so the caller can gate its transaction on `events.length` and avoid
 * committing on every no-op sweep (research §7).
 */
export function reconcile(state: DraftState, obs: Observation): ReduceResult {
  let picks = state.picks;
  if (obs.ledger) picks = applyLedger(picks, obs.ledger);
  if (obs.picks.length) picks = applyIncremental(picks, obs.picks);

  const diverged = firstDivergence(state.picks, picks);
  if (diverged === null) {
    // `firstDivergence` returns non-null whenever the lengths differ, so null
    // here means the pick list is byte-identical: a replayed batch, or a
    // safety-alarm sweep finding the cursor already current. Return the SAME
    // state object so the caller's `events.length` gate skips the commit.
    return { state, events: [] };
  }
  const divergedAt: number = diverged;

  const corrected = isCorrection(state.picks, picks);
  const revision = corrected ? state.revision + 1 : state.revision;

  // A correction invalidates turn events at and after the divergence: they
  // fired against a draft that no longer exists. Everything before it stands.
  const deckFired = { ...state.deckFired };
  const clockFired = { ...state.clockFired };
  if (corrected) {
    for (const map of [deckFired, clockFired]) {
      for (const key of Object.keys(map)) {
        if (Number(key) >= divergedAt) delete map[Number(key)];
      }
    }
  }

  let next: DraftState = { ...state, picks, revision, deckFired, clockFired };
  const events: DraftEvent[] = [];

  for (const p of picks) {
    const was = state.picks.find((q) => q.overall === p.overall);
    if (was && was.playerId === p.playerId && !corrected) continue;
    if (was && was.playerId === p.playerId && p.overall < divergedAt) continue;
    events.push({
      kind: "pick_made",
      revision,
      overall: p.overall,
      teamId: p.teamId,
      playerId: p.playerId,
      observedAt: p.observedAt,
    });
  }

  next = emitTurnEvents(next, events);

  if (next.totalPicks > 0 && next.picks.length >= next.totalPicks && !next.complete) {
    next = { ...next, complete: true };
    events.push({ kind: "draft_complete", revision, totalPicks: next.totalPicks });
  }

  return { state: { ...next, seq: state.seq + events.length }, events };
}

/**
 * Emit `on_deck` / `on_the_clock` for the owner's turns, exactly once each per
 * revision and always in that order.
 */
function emitTurnEvents(s: DraftState, events: DraftEvent[]): DraftState {
  if (s.myTeamId === null || s.order.length === 0) return s; // unknown order ⇒ no turn events
  const observed = observedMap(s);
  const f = frontier(s);
  const deckFired = { ...s.deckFired };
  const clockFired = { ...s.clockFired };

  const until = picksUntilTurn({
    order: s.order,
    frontier: f,
    myTeamId: s.myTeamId,
    observed,
    totalPicks: s.totalPicks || undefined,
  });
  if (until === null) return s;

  const turn = f + until;

  // on_deck first, and only within the lead window. `until` is the REAL
  // distance, which at a snake boundary is 1 rather than 2.
  if (until <= DECK_LEAD && deckFired[turn] !== s.revision) {
    deckFired[turn] = s.revision;
    events.push({ kind: "on_deck", revision: s.revision, overall: turn, picksUntil: until });
  }

  if (until === 0 && clockFired[turn] !== s.revision) {
    clockFired[turn] = s.revision;
    const team = teamAt({ order: s.order, overall: turn, observed }) ?? s.myTeamId;
    events.push({ kind: "on_the_clock", revision: s.revision, overall: turn, teamId: team });
  }

  return { ...s, deckFired, clockFired };
}
