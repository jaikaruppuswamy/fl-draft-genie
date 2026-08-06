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
  /**
   * Ledger-confirmed picks, at their REAL overall numbers. Authoritative.
   */
  confirmed: Pick[];
  /**
   * Streamed picks no ledger has confirmed yet, in ARRIVAL order.
   *
   * Kept separate because an incremental frame carries no ordinal — `SELECTED`
   * has none — so its overall can only ever be derived. Mixing the two lost
   * data: a ledger merged by ordinal onto position-derived numbers evicts
   * whatever the stream had parked at those slots. See `applyLedger`.
   */
  pending: Pick[];
  /** Derived: `confirmed`, then `pending` numbered from the ledger's high water. */
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
    confirmed: [],
    pending: [],
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

/**
 * Merge a ledger snapshot. It is authoritative for the range it covers.
 *
 * THE BUG THIS REPLACES lost picks outright. The old version merged into a map
 * keyed on `overall` only, so when a dropped frame had shifted the derived
 * numbering, a *truthful* ledger silently evicted whatever the stream had
 * parked at the slots it restated. Reproduced: tab A drops one frame and
 * relays 10 of 11 real picks; tab B's 8-row ledger then arrives; the result is
 * 10 picks for 11 real ones with one player deleted, still dense, so nothing
 * detects it — and `frontier` is wrong for the rest of the draft. The revision
 * bumped, which only made consumers re-apply the corrupted list.
 *
 * The fix is to stop mixing the two sources. A ledger row carries a REAL
 * ordinal; a `SELECTED` frame carries none and can only be positioned by
 * derivation. So ledger rows become `confirmed` at their stated overalls, and
 * anything the ledger claims is removed from `pending` by PLAYER IDENTITY —
 * never by position.
 */
function applyLedger(s: DraftState, ledger: PickObservation[]): { confirmed: Pick[]; pending: Pick[] } {
  if (ledger.length === 0) return { confirmed: s.confirmed, pending: s.pending };

  const byOverall = new Map(s.confirmed.map((p) => [p.overall, p]));
  // Rows without an ordinal cannot be placed by this path at all; they are
  // treated as stream arrivals rather than invented into a slot.
  const ordinalLess: PickObservation[] = [];
  let covered = 0;

  for (const o of ledger) {
    if (o.overallPickNumber === undefined) {
      ordinalLess.push(o);
      continue;
    }
    const overall = o.overallPickNumber;
    covered = Math.max(covered, overall);
    const existing = byOverall.get(overall);
    // FIRST-SEEN-WINS on observed_at, so a rebuild cannot flatten the per-pick
    // timing 008 depends on.
    byOverall.set(overall, { ...toPick(o, overall), observedAt: existing?.observedAt ?? o.observedAt });
  }

  const confirmed = sortPicks([...byOverall.values()]);
  const claimed = new Set(confirmed.map((p) => p.playerId));

  // Drop by IDENTITY, not position: a player the ledger has now placed must not
  // survive at whatever slot derivation had guessed for it.
  const pending = s.pending.filter((p) => !claimed.has(p.playerId));

  // Ordinal-less rows are stream arrivals, not placements — and they must be
  // deduped against what we ALREADY hold, or a ledger restating known picks
  // records every one of them a second time. Verified: two streamed picks plus
  // an ordinal-less ledger restating the same two yielded four picks, a
  // frontier two ahead of reality, and no correction flagged. Reachable
  // because `feed.ts` sets `overallPickNumber: undefined` for any non-integer,
  // so one shape change upstream is enough.
  const known = new Set([...claimed, ...pending.map((p) => p.playerId)]);
  for (const o of ordinalLess) {
    if (known.has(o.playerId)) continue;
    known.add(o.playerId);
    pending.push(toPick(o, 0));
  }
  return { confirmed, pending };
}

/** Record streamed picks, collapsing anything already known by identity. */
function applyIncremental(s: DraftState, picks: PickObservation[]): Pick[] {
  const known = new Set([...s.confirmed, ...s.pending].map((p) => p.playerId));
  const pending = [...s.pending];
  for (const o of picks) {
    if (known.has(o.playerId)) continue; // two tabs, or a replayed batch
    known.add(o.playerId);
    pending.push(toPick(o, 0)); // position assigned by `materialise`
  }
  return pending;
}

/**
 * Build the visible pick list: ledger truth first, then streamed arrivals
 * numbered from the ledger's high-water mark.
 *
 * Numbering only the UNCONFIRMED tail is what makes a dropped frame a
 * bounded error instead of a permanent one: the next ledger that covers the
 * gap repairs the numbering, and nothing is ever evicted in the meantime.
 */
function materialise(confirmed: Pick[], pending: Pick[]): Pick[] {
  const out = [...confirmed];
  const taken = new Set(confirmed.map((p) => p.overall));
  let next = 1;
  // Number by WHEN THE PICK WAS OBSERVED, not when its batch happened to
  // arrive. A pick recovered late from a second tab — the first tab dropped
  // its frame — would otherwise be appended at the end of the draft: a
  // first-round player recorded as the last pick, with every intervening
  // ordinal shifted one early.
  //
  // Stamps compare only WITHIN an epoch (the tap re-anchors its clock across
  // sleep), so epoch orders first and the sort is stable, leaving same-instant
  // arrivals in the order they were seen.
  const ordered = [...pending].sort((a, b) =>
    a.epoch !== b.epoch ? a.epoch - b.epoch : a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0,
  );
  for (const p of ordered) {
    while (taken.has(next)) next++;
    taken.add(next);
    out.push({ ...p, overall: next });
    next++;
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

/** A ledger refused as belonging to a different draft (011 FR-025). */
export interface RejectedLedger {
  reason: "complete_ledger_at_unstarted_session";
  rows: number;
  totalPicks: number;
}

export interface ReduceResult {
  state: DraftState;
  events: DraftEvent[];
  /**
   * Set when a ledger was refused as belonging to a different draft.
   *
   * Surfaced on the result rather than logged inside, so the caller decides how
   * loudly to record it — and so a test can assert the refusal happened rather
   * than only that picks are absent.
   */
  rejectedLedger?: RejectedLedger;
}

/**
 * Fold one observation into the draft.
 *
 * Returns the SAME state object and an empty event list when nothing changed,
 * so the caller can gate its transaction on `events.length` and avoid
 * committing on every no-op sweep (research §7).
 */
/**
 * 011 T035 — may this ledger become the session's baseline?
 *
 * A ledger frame carries NOTHING identifying its draft: the payload is
 * `{teamId, playerId, slot3, overallPickNumber}`, and the wrapper adds only when
 * the tap saw it. The tap session does not help either — one session emitted
 * ledgers for two different drafts across a league reconnect on 2026-08-06.
 *
 * So the binding is behavioural, and there is a usable signature:
 *
 *   A LIVE draft's ledger arrives early and PARTIAL, and the incremental stream
 *   fills it in — 010 measured 69 of 72 picks arriving incrementally, 3 only by
 *   ledger. A COMPLETED draft's ledger is complete on arrival.
 *
 * Therefore: a ledger accounting for a whole draft, reaching a session that has
 * never observed an incremental pick, is describing a DIFFERENT draft.
 *
 * WHAT THIS MUST NOT DO is break recovery, which is the entire purpose of
 * ledgers. A session that has seen picks always accepts — that is the reload
 * case — and a partial ledger at a fresh session is a live draft starting,
 * which is normal.
 *
 * Residual risk, stated: a finished draft re-ingested from scratch is refused.
 * That draft has already happened; refusing to re-ingest costs nothing, and the
 * refusal is recorded rather than silent (FR-025).
 */
function ledgerDescribesAnotherDraft(s: DraftState, ledger: PickObservation[]): boolean {
  // A session that has observed anything is on its own draft's timeline.
  if (s.picks.length > 0) return false;
  // `totalPicks === 0` means the draft's length is not established, so
  // "complete" cannot be judged — and claiming it could would be the same
  // mistake as 006 reading an unknown total as a real one.
  if (s.totalPicks <= 0) return false;

  let covered = 0;
  for (const o of ledger) covered = Math.max(covered, o.overallPickNumber ?? 0);
  return covered >= s.totalPicks;
}

export function reconcile(state: DraftState, obs: Observation): ReduceResult {
  // Ledger FIRST: it is authoritative, and applying it before the stream means
  // an incremental frame for a pick the ledger already placed is recognised as
  // a duplicate rather than appended a second time.
  let confirmed = state.confirmed;
  let pending = state.pending;
  let rejectedLedger: RejectedLedger | null = null;
  if (obs.ledger) {
    if (ledgerDescribesAnotherDraft(state, obs.ledger)) {
      // RECORDED, never silent (FR-025): a genuine recovery must never be
      // mistaken for contamination, and the only way to tell them apart later
      // is to have said which this was.
      rejectedLedger = {
        reason: "complete_ledger_at_unstarted_session",
        rows: obs.ledger.length,
        totalPicks: state.totalPicks,
      };
    } else {
      const merged = applyLedger(state, obs.ledger);
      confirmed = merged.confirmed;
      pending = merged.pending;
    }
  }
  if (obs.picks.length) {
    pending = applyIncremental({ ...state, confirmed, pending }, obs.picks);
  }
  const picks = materialise(confirmed, pending);

  const diverged = firstDivergence(state.picks, picks);
  if (diverged === null) {
    // `firstDivergence` returns non-null whenever the lengths differ, so null
    // here means the pick list is byte-identical: a replayed batch, or a
    // safety-alarm sweep finding the cursor already current. Return the SAME
    // state object so the caller's `events.length` gate skips the commit.
    return { state, events: [], ...(rejectedLedger ? { rejectedLedger } : {}) };
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

  let next: DraftState = { ...state, confirmed, pending, picks, revision, deckFired, clockFired };
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

  return {
    state: { ...next, seq: state.seq + events.length },
    events,
    ...(rejectedLedger ? { rejectedLedger } : {}),
  };
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
