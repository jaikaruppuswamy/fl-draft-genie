// 006 T007 — where does ESPN's ADP stop meaning anything?
//
// THE PROBLEM, measured against production 2026-08-05:
//
//   522 projected players, ALL with an ADP. Maximum 171.59.
//   325 of them (62%) sit in the band 169–171.6.
//   The six most common values are 169.99, 169.98, 169.95, 169.97, 169.94,
//   169.93 — carrying 28, 28, 20, 16, 16 and 15 players each.
//
// That cluster is not a draft position. It is ESPN saying "outside our
// sample", and a value there means the same thing as no value at all. Read
// literally, 006's survival rule (FR-022) would have ranked two thirds of the
// board as safely lasting to the owner's next turn — and would have been most
// confident about it in exactly the late rounds where it is least true.
//
// WHY DENSITY, AND NOT THE NUMBER 169.9:
//
//   below ADP 150   145 players over ~148 ADP units  ≈    1 player / unit
//   169 – 171.6     325 players over ~2.6 ADP units  ≈  125 players / unit
//
// A separation of roughly 100x. Any threshold ratio between 5 and 50 finds the
// same boundary, which `tests/engine/adp-floor.test.ts` asserts directly — so
// the constant is provably not load-bearing, and a season in which ESPN's floor
// lands at 210 is handled without anyone noticing it moved.
//
// Hardcoding 169.9 would have been THIS season's number in a general-purpose
// disguise, and Constitution II exists to stop exactly that.

import { FLOOR_DENSITY_RATIO } from "../engine/constants";

/**
 * The lowest ADP at which values stop discriminating, or `null` if they never
 * do. Players at or above the returned value MUST be treated as having no ADP.
 *
 * Pure: takes the numbers, returns a number. The engine receives the result as
 * an input rather than computing it, so `recommend()` stays a function of its
 * arguments (FR-010).
 */
export function detectAdpFloor(adps: readonly (number | null)[]): number | null {
  const values = adps.filter((a): a is number => a !== null && Number.isFinite(a)).sort((a, b) => a - b);
  // Too few to say anything about shape. Claiming a floor here would be
  // inventing one.
  if (values.length < 20) return null;

  const min = values[0]!;
  const max = values[values.length - 1]!;
  const span = max - min;
  if (span <= 0) return null;

  // Bucket into a fixed number of equal-width bins so "density" is comparable
  // across bins regardless of how ESPN happens to round.
  const BINS = 64;
  const width = span / BINS;
  const counts = new Array<number>(BINS).fill(0);
  for (const v of values) {
    const i = Math.min(BINS - 1, Math.floor((v - min) / width));
    counts[i] = counts[i]! + 1;
  }

  // Compare against the MEDIAN of non-empty bins rather than the mean: the
  // floor cluster is itself huge, and a mean it contributes to would be
  // dragged up until the cluster no longer looked exceptional.
  const occupied = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const median = occupied[Math.floor(occupied.length / 2)]!;
  if (median <= 0) return null;

  const threshold = median * FLOOR_DENSITY_RATIO;

  // Walk DOWN from the top. The floor is the maximal run of dense bins that
  // reaches the maximum ADP — a dense bin in the middle of the board is a
  // popular ADP, not a saturation floor, and must not be mistaken for one.
  let i = BINS - 1;
  while (i >= 0 && counts[i] === 0) i--; // trailing empties
  if (i < 0 || counts[i]! < threshold) return null;
  while (i >= 0 && (counts[i]! >= threshold || counts[i] === 0)) i--;

  const floor = min + (i + 1) * width;
  // A "floor" covering essentially the whole distribution means the data has no
  // usable shape at all; treating everything as absent is worse than treating
  // nothing as absent, because it silently disables a rule the spec requires.
  if (values.filter((v) => v >= floor).length > values.length * 0.9) return null;
  return floor;
}

/** Is this ADP informative, given the detected floor? */
export function adpIsUsable(adp: number | null, floor: number | null): adp is number {
  if (adp === null || !Number.isFinite(adp)) return false;
  return floor === null || adp < floor;
}
