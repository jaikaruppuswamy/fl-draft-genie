// 008 T052 — how real drafters behave relative to ADP.
//
// This is the ONLY job the unreplayable imports have, and it is a real one:
// it is the difference between an opponent model whose noise came from data
// and one whose noise came from taste.
//
// A `pick_sequence_only` entry has no board and can never be replayed — no
// projection set exists for its season and ESPN will not serve one. But the
// pick sequence itself still says something true about how a room drafts: how
// far ahead of ADP players actually go, and how much spread there is around it.
//
// THE ENGINE IS NEVER INVOKED HERE. There is no bundle to invoke it with, and
// running it against today's board over a 2024 sequence would produce numbers
// that look like evidence and are not.

import type { CorpusEntry } from "./corpus";

export interface AdpObservation {
  /** overall pick number − the player's ADP. Negative ⇒ taken EARLIER than ADP. */
  delta: number;
  overall: number;
}

/**
 * Below this many usable picks, no spread is reported at all.
 *
 * The first real run of this function produced a confident `noiseSd` of 27 from
 * TWO samples out of 140 — and both were accidental id collisions. A number
 * with an arrow pointing at it is worse than no number, because it gets used.
 */
export const MIN_SAMPLE = 30;

/** And below this fraction of the picks, the sample is not representative. */
export const MIN_COVERAGE = 0.25;

export interface AdpBehaviour {
  sampleSize: number;
  /** Mean signed deviation. Near zero means the room drafts close to ADP. */
  mean: number | null;
  /** The spread — what an opponent model's noise should be set from. */
  standardDeviation: number | null;
  median: number | null;
  /** Picks whose player had no usable ADP, so contributed nothing. */
  skippedNoAdp: number;
  entriesUsed: string[];
  /**
   * Non-null when NO measurement is reported, saying why.
   *
   * Every numeric field above is null whenever this is set. The alternative —
   * reporting a spread and letting the caller notice the sample was tiny or the
   * seasons did not match — is how a garbage parameter reaches a model.
   */
  refusal: string | null;
}

/**
 * ADP for one player, as of the draft being measured.
 *
 * Supplied by the caller because a `pick_sequence_only` entry carries no board:
 * the ADP has to come from wherever the caller can honestly get it, and this
 * module must not pretend otherwise.
 */
export type AdpLookup = (playerId: number) => number | null;

export function observeAdpBehaviour(
  entries: readonly CorpusEntry[],
  adpOf: AdpLookup,
  adpFloor: number | null,
  /**
   * The season the ADP values come from. REQUIRED, and checked.
   *
   * Measuring a 2025 draft against 2026 ADP does not measure how that room
   * drafted — it measures a year of player aging, injury and depth-chart
   * change, with drafter behaviour somewhere underneath. And by exactly the
   * reasoning that makes a past season unreplayable (no projection set was ever
   * captured), there is no contemporaneous ADP for it either.
   *
   * So this is a hard refusal rather than a caveat. A caveat printed beside a
   * number is not a defence: the number still gets used.
   */
  adpSeason: number,
): AdpBehaviour {
  const empty = (refusal: string): AdpBehaviour => ({
    sampleSize: 0,
    mean: null,
    standardDeviation: null,
    median: null,
    skippedNoAdp: 0,
    entriesUsed: [],
    refusal,
  });

  const mismatched = entries.filter((e) => e.season !== adpSeason).map((e) => e.id);
  if (mismatched.length > 0) {
    return empty(
      `ADP is from ${adpSeason}; ${mismatched.length} entr(y|ies) are from another season (${mismatched.slice(0, 3).join(", ")}). ` +
        `Cross-season ADP measures player value change, not drafter behaviour.`,
    );
  }

  const deltas: number[] = [];
  const used: string[] = [];
  let skipped = 0;

  for (const entry of entries) {
    let contributed = false;
    for (const pick of entry.picks) {
      const adp = adpOf(pick.playerId);
      // ESPN's ADP SATURATES: in the current serving set 325 of 522 players
      // share a floor value near 169.9, which means "no meaningful ADP" rather
      // than "picked around 170". Treating the floor as a real number would
      // manufacture a huge, entirely fictional spread — exactly the parameter
      // this function exists to measure.
      if (adp === null || (adpFloor !== null && adp >= adpFloor)) {
        skipped++;
        continue;
      }
      deltas.push(pick.overall - adp);
      contributed = true;
    }
    if (contributed) used.push(entry.id);
  }

  const totalPicks = entries.reduce((n, e) => n + e.picks.length, 0);
  const coverage = totalPicks === 0 ? 0 : deltas.length / totalPicks;

  if (deltas.length < MIN_SAMPLE || coverage < MIN_COVERAGE) {
    return {
      ...empty(
        `only ${deltas.length} of ${totalPicks} picks had a usable ADP ` +
          `(need ${MIN_SAMPLE}+ and ${Math.round(MIN_COVERAGE * 100)}% coverage). ` +
          `A spread from a sample this thin is noise wearing a parameter's clothes.`,
      ),
      skippedNoAdp: skipped,
    };
  }

  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  // Population standard deviation, not sample: this describes the drafts
  // observed rather than estimating a wider population, and with one draft the
  // sample form would divide by n−1 for no reason anyone could defend.
  const variance = deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length;

  return {
    sampleSize: deltas.length,
    mean: round4(mean),
    standardDeviation: round4(Math.sqrt(variance)),
    median: round4(median(deltas)),
    skippedNoAdp: skipped,
    entriesUsed: used.sort(),
    refusal: null,
  };
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
