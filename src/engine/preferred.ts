// 006 T041 — the preferred-player boost.
//
// PURE. No platform imports, no clock.
//
// THE UNIT IS THE POINT (FR-007). A flat "+8 points for a preferred player"
// would mean something quite different in a full-PPR league than a standard
// one, and something different again in a 14-team league — so it would violate
// Constitution II and III while looking perfectly reasonable in the code.
//
// The cap is `PREFERRED_CAP × ROUND_VALUE`: about one round early. That is a
// sentence an owner can act on, it scales with the league on its own, and it
// makes SC-006 true by construction — a player whose raw value trails the
// leader by more than a round's worth can never be lifted to the top.
//
// The boost is emitted as a DISTINCTLY IDENTIFIED adjustment carrying the exact
// value it contributed (FR-026), so a display can badge the player and show
// what the preference was worth without recomputing anything. That is the
// contract 007 renders against.

import { PREFERRED_CAP } from "./constants";
import type { Adjustment } from "./types";

/**
 * The boost, or `null` when the player is not on the list.
 *
 * Flat rather than graded: the list is a SET, not an ordering (see
 * `db/preferred.ts`). Grading it would invent a preference strength the owner
 * never expressed.
 */
export function preferredAdjustment(isPreferred: boolean, roundValue: number): Adjustment | null {
  if (!isPreferred || roundValue <= 0) return null;
  const magnitude = PREFERRED_CAP * roundValue;
  return {
    rule: "preferred",
    magnitude: Math.round(magnitude * 100) / 100,
    direction: "up",
    reason: "on your preferred list",
  };
}
