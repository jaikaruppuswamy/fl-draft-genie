// 006 T025 — roster construction, and the one rule allowed to override value.
//
// PURE. No platform imports, no clock.
//
// FR-025 IS DELIBERATELY THE MOST CONSERVATIVE RULE IN THE ENGINE.
//
// While the owner has more picks left than unfilled mandatory slots, the honest
// answer is still the best player, with a visible warning. Only when those two
// numbers are EQUAL does every remaining pick become forced — and at that point
// there is nothing to weigh, because any other choice provably leaves the
// roster short.
//
// Nothing weights a mandated position upward before that boundary. That is not
// caution for its own sake: the alternative — an urgency curve that ramps as
// the deadline nears — has no principled basis and exactly one failure mode,
// which is a kicker creeping into the shortlist while real starters are still
// on the board. The spec chose this explicitly during clarification.

import { normalisePosition } from "./value";
import type { RosteredPlayer } from "./types";
import type { RosterSnapshot } from "../espn/parsers";

/** Slots that require a SPECIFIC position, and so can go unfilled. */
const MANDATORY_SLOT: Record<number, string> = {
  0: "QB",
  2: "RB",
  4: "WR",
  6: "TE",
  16: "DST",
  17: "K",
};

export interface RosterNeed {
  position: string;
  /** How many the league requires this owner to start. */
  required: number;
  owned: number;
  unfilled: number;
}

export interface RosterStatus {
  needs: RosterNeed[];
  /** Total mandatory slots still to fill. */
  unfilledMandatory: number;
  /** NULL when the draft's length is not yet known — see `EngineState`. */
  remainingPicks: number | null;
  /** Every remaining pick is forced (FR-025). Never true while picks are unknown. */
  forced: boolean;
  /** Already impossible — more unfilled slots than picks left. */
  unsatisfiable: boolean;
  /** Positions that would fill a mandatory slot. Empty when nothing is needed. */
  neededPositions: Set<string>;
}

export function rosterStatus(
  roster: RosterSnapshot,
  myRoster: readonly RosteredPlayer[],
  remainingPicks: number | null,
): RosterStatus {
  const required = new Map<string, number>();
  for (const slot of roster.slots) {
    const pos = MANDATORY_SLOT[slot.slotId];
    if (!pos || slot.count <= 0) continue;
    required.set(pos, (required.get(pos) ?? 0) + slot.count);
  }

  const owned = new Map<string, number>();
  for (const p of myRoster) {
    const pos = normalisePosition(p.position);
    owned.set(pos, (owned.get(pos) ?? 0) + 1);
  }

  const needs: RosterNeed[] = [];
  const neededPositions = new Set<string>();
  let unfilledMandatory = 0;
  // Sorted so the output — and any warning built from it — is deterministic.
  for (const pos of [...required.keys()].sort()) {
    const req = required.get(pos)!;
    const have = owned.get(pos) ?? 0;
    // A surplus at one position never fills a slot at another: three running
    // backs do not cover a missing kicker.
    const unfilled = Math.max(0, req - have);
    needs.push({ position: pos, required: req, owned: have, unfilled });
    if (unfilled > 0) {
      neededPositions.add(pos);
      unfilledMandatory += unfilled;
    }
  }

  return {
    needs,
    unfilledMandatory,
    remainingPicks,
    // Both of these are CLAIMS about the future, so neither may be made while
    // the number of remaining picks is unknown (null). Before a draft is armed
    // the honest position is "you still need these positions" — not "every pick
    // is forced" and certainly not "this roster cannot be completed".
    //
    // `> 0` also matters: with nothing unfilled and no picks left, nothing is
    // "forced" — the roster is simply complete.
    forced:
      remainingPicks !== null &&
      unfilledMandatory > 0 &&
      remainingPicks > 0 &&
      remainingPicks <= unfilledMandatory,
    unsatisfiable: remainingPicks !== null && unfilledMandatory > remainingPicks,
    neededPositions,
  };
}

/** Does taking this player fill a mandatory slot the owner still needs? */
export function fillsNeed(position: string, status: RosterStatus): boolean {
  return status.neededPositions.has(normalisePosition(position));
}

/** The standing warning shown while mandatory slots remain unfilled (FR-025). */
export function mandatoryWarning(status: RosterStatus): string | null {
  if (status.unfilledMandatory === 0) return null;
  const positions = [...status.neededPositions].sort().join(", ");
  // With the pick count unknown, say what IS known and stop there rather than
  // inventing "0 picks left".
  if (status.remainingPicks === null) return `${positions} still unfilled`;
  const picks = status.remainingPicks === 1 ? "1 pick" : `${status.remainingPicks} picks`;
  return `${positions} still unfilled, ${picks} left`;
}
