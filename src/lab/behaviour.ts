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
): AdpBehaviour {
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

  if (deltas.length === 0) {
    return {
      sampleSize: 0,
      mean: null,
      standardDeviation: null,
      median: null,
      skippedNoAdp: skipped,
      entriesUsed: [],
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
