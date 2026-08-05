// 006 T020 — the two rules that read ADP.
//
// PURE. No platform imports, no clock.
//
// ADP answers two DIFFERENT questions, and the spec asks for both:
//
//   slot_value (FR-005)  has this player fallen past where the market takes him?
//   survival   (FR-022)  will he still be here at my next turn?
//
// They are separate adjustments with separate names and separate magnitudes,
// because FR-024 requires survival be named and FR-027 requires each carry its
// own number. But they read the SAME COLUMN, so a player who has fallen AND
// will not last would otherwise be paid twice for one fact. Their sum is
// clamped to `ADP_COMBINED_CAP × ROUND_VALUE`.
//
// THE FLOOR. ESPN's ADP saturates: measured 2026-08-05, 325 of 522 projected
// players sit at ~169.9 against a maximum of 171.6. A value there means
// "outside our sample", NOT "goes at pick 170". Both rules therefore treat a
// floored ADP as an ABSENT one and make no claim in either direction. Without
// this the survival rule would mark two thirds of the board as safely lasting,
// and would be most confident in exactly the late rounds where it is least
// true.

import { ADP_COMBINED_CAP } from "./constants";
import type { Adjustment } from "./types";

/**
 * How far past their ADP a player must fall to earn the full `slot_value`
 * bonus, as a fraction of a round. Beyond this the bonus stops growing —
 * a player who fell three rounds is not three times the bargain.
 */
const FULL_FALL_ROUNDS = 2;

/** Weight of each of the two rules before the shared clamp, in ROUND_VALUE units. */
const SLOT_VALUE_WEIGHT = 0.4;
const SURVIVAL_WEIGHT = 0.5;

export interface AdpInput {
  /** The player's ADP, or null. Callers pass null for a FLOORED value too. */
  adp: number | null;
  /** The pick now on the clock. */
  currentOverall: number;
  /** Picks until the owner's next turn; NULL means there is no next turn. */
  gapToNextTurn: number | null;
  teamCount: number;
  roundValue: number;
}

export interface AdpResult {
  adjustments: Adjustment[];
  /** Set when ADP was unusable — the explanation says what was missing (FR-013). */
  missingAdp: boolean;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Both ADP rules, with their combined magnitude clamped.
 *
 * Returns NO adjustments when the ADP is absent or floored — an absence is
 * reported as a missing input, never as a zero. A zero would claim we looked
 * and found nothing to say; the truth is that we could not look.
 */
export function adpAdjustments(i: AdpInput): AdpResult {
  if (i.adp === null || !Number.isFinite(i.adp) || i.roundValue <= 0) {
    return { adjustments: [], missingAdp: i.adp === null || !Number.isFinite(i.adp) };
  }

  const raw: Adjustment[] = [];

  // --- slot_value (FR-005) -------------------------------------------------
  // Positive when the player has fallen past his ADP. Reaching is NOT punished
  // — the owner may have reasons the engine cannot see — it simply earns no
  // bonus. A penalty here would double as a second opinion on a decision the
  // owner has not made yet.
  const fell = i.currentOverall - i.adp;
  if (fell > 0) {
    const fullFall = Math.max(1, FULL_FALL_ROUNDS * i.teamCount);
    const magnitude = SLOT_VALUE_WEIGHT * Math.min(1, fell / fullFall) * i.roundValue;
    if (magnitude > 0) {
      raw.push({
        rule: "slot_value",
        magnitude,
        direction: "up",
        reason: `going ${Math.round(fell)} picks later than his average draft position`,
      });
    }
  }

  // --- survival (FR-022, FR-023) -------------------------------------------
  // Skipped entirely when there is no next turn. Its absence is NOT a missing
  // signal: there is nothing to be missing, because the question does not
  // arise at the owner's final pick.
  if (i.gapToNextTurn !== null && i.gapToNextTurn > 0) {
    const nextTurn = i.currentOverall + i.gapToNextTurn;
    // 1 when he is certainly gone by the next turn, 0 when he is certainly
    // there, linear between. A logistic curve would look more rigorous, but
    // ESPN publishes no ADP dispersion, so its width would be invented — a
    // fabricated precision on top of a column that is already 62% floor.
    const span = nextTurn - i.currentOverall;
    const risk = Math.min(1, Math.max(0, (nextTurn - i.adp) / span));
    if (risk > 0) {
      const magnitude = SURVIVAL_WEIGHT * risk * i.roundValue;
      raw.push({
        rule: "survival",
        magnitude,
        direction: "up",
        reason:
          risk >= 1
            ? `very unlikely to last your next ${i.gapToNextTurn} picks`
            : `may not last your next ${i.gapToNextTurn} picks`,
      });
    }
  }

  // --- the shared clamp ----------------------------------------------------
  // Both rules read the same column. Unclamped, the ADP signal can dominate
  // value itself, which is how a draft assistant starts chasing names.
  const cap = ADP_COMBINED_CAP * i.roundValue;
  const total = raw.reduce((sum, a) => sum + Math.abs(a.magnitude), 0);
  const scale = total > cap && total > 0 ? cap / total : 1;

  return {
    adjustments: raw.map((a) => ({ ...a, magnitude: round2(a.magnitude * scale) })),
    missingAdp: false,
  };
}
