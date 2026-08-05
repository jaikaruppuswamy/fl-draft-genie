// 006 T036 — assembling an explanation, and the invariant that makes it honest.
//
// PURE. No platform imports, no clock.
//
// THE RECONCILIATION INVARIANT (FR-027, SC-014):
//
//     finalValue − rawValue === sum(adjustments.magnitude)
//
// This is what turns "explainable" from a quality a reviewer has to judge into
// a property a test can fail on. An explanation whose parts do not add up to
// its total means SOMETHING MOVED THE RANKING THAT THE OWNER WAS NEVER TOLD
// ABOUT — which is precisely the failure Constitution VII forbids, and exactly
// the kind that survives code review because every individual rule looks right.
//
// `finalValue` is therefore DERIVED from the adjustments here rather than
// computed alongside them. The invariant cannot drift if there is only one
// place the number comes from.

import { ALTERNATIVES_SHOWN } from "./constants";
import type { Adjustment, Explanation, MissingInput } from "./types";

/** Float tolerance for the invariant. Magnitudes are rounded to 2dp at source. */
export const RECONCILE_EPSILON = 0.005;

export interface ExplainInput {
  rawValue: number;
  roundValue: number;
  adjustments: readonly Adjustment[];
  missing: readonly MissingInput[];
  forcedBy: string | null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The final value implied by the adjustments. The ONLY place it is computed. */
export function finalValueOf(rawValue: number, adjustments: readonly Adjustment[]): number {
  return round2(adjustments.reduce((sum, a) => sum + a.magnitude, round2(rawValue)));
}

export function explain(i: ExplainInput): Explanation {
  return {
    rawValue: round2(i.rawValue),
    finalValue: finalValueOf(i.rawValue, i.adjustments),
    roundValue: round2(i.roundValue),
    // Deterministic order, so two runs over the same state serialise
    // identically (SC-003). Sorted by rule name rather than by magnitude:
    // magnitudes tie, names do not.
    adjustments: [...i.adjustments].sort((a, b) => a.rule.localeCompare(b.rule)),
    missing: [...i.missing].sort((a, b) => a.input.localeCompare(b.input)),
    // Filled in by the caller once the full ordering exists.
    alternatives: [],
    forcedBy: i.forcedBy,
  };
}

/** Does this explanation add up? The invariant, as a function. */
export function reconciles(e: Explanation): boolean {
  const sum = e.adjustments.reduce((s, a) => s + a.magnitude, 0);
  return Math.abs(e.finalValue - e.rawValue - sum) <= RECONCILE_EPSILON;
}

/**
 * The next-best players, for FR-009's "alternatives considered".
 *
 * Deliberately taken from the ranked board rather than recomputed: the
 * alternatives an owner is shown must be the ones the engine actually weighed.
 */
export function alternativesFor<T extends { playerId: number; name: string; finalValue: number }>(
  ordered: readonly T[],
  index: number,
): Explanation["alternatives"] {
  const out: Explanation["alternatives"] = [];
  for (let k = index + 1; k < ordered.length && out.length < ALTERNATIVES_SHOWN; k++) {
    const p = ordered[k]!;
    out.push({ playerId: p.playerId, name: p.name, finalValue: p.finalValue });
  }
  return out;
}
