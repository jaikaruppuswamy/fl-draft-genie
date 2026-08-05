// 006 T016 — ROUND_VALUE, including the degenerate tail.
//
// The end of the draft is where this is most likely to go wrong: the board runs
// short, and the naive `values[teamCount]` reads off the end and produces
// `NaN`. Every adjustment in the engine is a multiple of this number, so a NaN
// here does not fail loudly — it propagates into every magnitude and every
// explanation, and the reconciliation invariant starts comparing NaN to NaN.

import { describe, expect, it } from "vitest";
import { roundValue } from "../../src/engine/value";

describe("roundValue", () => {
  it("is the value given up by waiting one full round", () => {
    // 12 teams: the drop from the best available to the 13th.
    const values = Array.from({ length: 40 }, (_, i) => 100 - i * 2);
    expect(roundValue(values, 12)).toBe(100 - (100 - 12 * 2));
  });

  it("scales with team count — a bigger league loses more by waiting", () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 - i * 2);
    expect(roundValue(values, 14)).toBeGreaterThan(roundValue(values, 10));
  });

  it("shrinks late, as values flatten", () => {
    // Correct behaviour, not a bug: reaching matters less in round 15.
    const early = Array.from({ length: 40 }, (_, i) => 100 - i * 3);
    const late = Array.from({ length: 40 }, (_, i) => 8 - i * 0.1);
    expect(roundValue(late, 12)).toBeLessThan(roundValue(early, 12));
  });

  it("falls back to top-minus-last when fewer than teamCount+1 remain", () => {
    // The degenerate tail. `values[12]` does not exist here.
    const values = [50, 40, 30];
    expect(roundValue(values, 12)).toBe(20);
    expect(Number.isNaN(roundValue(values, 12))).toBe(false);
  });

  it("returns 0 with fewer than two players", () => {
    expect(roundValue([50], 12)).toBe(0);
    expect(roundValue([], 12)).toBe(0);
  });

  it("never returns a negative, even if the caller sorts wrongly", () => {
    // A negative unit would flip the SIGN of every adjustment in the engine —
    // a bye clash would become a bonus. Clamping is cheap insurance against a
    // caller-side ordering mistake that would otherwise be near-impossible to
    // spot in an explanation.
    expect(roundValue([10, 20, 30, 40], 2)).toBe(0);
  });

  it("is finite for every input shape the draft can produce", () => {
    for (const values of [[], [1], [1, 1], [5, 5, 5, 5], [0, 0]]) {
      expect(Number.isFinite(roundValue(values, 12))).toBe(true);
    }
  });
});
