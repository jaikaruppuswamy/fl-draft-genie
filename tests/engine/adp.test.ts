// 006 T018/T019 — the two ADP rules, and the clamp that stops them
// double-counting.
//
// The clamp test constructs EXACTLY the player the clamp exists for: one who
// has fallen well past his ADP and also will not survive the gap. Asserting the
// bound arithmetically over random inputs would pass without ever building that
// player, which is how a clamp ships untested.

import { describe, expect, it } from "vitest";
import { adpAdjustments } from "../../src/engine/adp";
import { ADP_COMBINED_CAP } from "../../src/engine/constants";

const ROUND = 10;

function run(over: Partial<Parameters<typeof adpAdjustments>[0]> = {}) {
  return adpAdjustments({
    adp: 20,
    currentOverall: 20,
    gapToNextTurn: 12,
    teamCount: 12,
    roundValue: ROUND,
    ...over,
  });
}

const by = (r: ReturnType<typeof run>, rule: string) => r.adjustments.find((a) => a.rule === rule);

describe("an absent or floored ADP (FR-022, SC-012)", () => {
  it("produces NO adjustment in either direction when ADP is null", () => {
    const r = run({ adp: null });
    expect(r.adjustments).toEqual([]);
    expect(r.missingAdp).toBe(true);
  });

  it("produces NO adjustment for a FLOORED ADP — the caller passes null for it", () => {
    // 62% of the projected pool sits at ESPN's floor. This is the assertion
    // that stops the engine ranking two thirds of the board as safely lasting.
    // The floor is applied upstream (`adpIsUsable`), so a floored player
    // arrives here as `null` and must be indistinguishable from a missing one.
    const floored = run({ adp: null });
    const missing = run({ adp: null });
    expect(floored.adjustments).toEqual(missing.adjustments);
    expect(floored.adjustments).toEqual([]);
  });

  it("makes no claim that a floored player will LAST either", () => {
    // The symmetric error: treating "no data" as "he'll be there" is just as
    // wrong as treating it as "he's gone", and quieter.
    expect(run({ adp: null }).adjustments.map((a) => a.rule)).not.toContain("survival");
  });

  it("does not crash on a non-finite ADP", () => {
    expect(run({ adp: Number.NaN }).adjustments).toEqual([]);
    expect(run({ adp: Number.POSITIVE_INFINITY }).adjustments).toEqual([]);
  });
});

describe("survival (FR-022, FR-023)", () => {
  it("fires when the player will not last the gap", () => {
    // On the clock at 20, next turn at 32, his ADP is 24 — he goes before then.
    const r = run({ currentOverall: 20, gapToNextTurn: 12, adp: 24 });
    expect(by(r, "survival")).toBeDefined();
    expect(by(r, "survival")!.magnitude).toBeGreaterThan(0);
    expect(by(r, "survival")!.reason).toMatch(/last your next 12 picks/);
  });

  it("does NOT fire when the player will comfortably last", () => {
    const r = run({ currentOverall: 20, gapToNextTurn: 12, adp: 90 });
    expect(by(r, "survival")).toBeUndefined();
  });

  it("is monotone — a nearer ADP never scores lower than a further one", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const adp of [21, 24, 27, 30, 32, 40]) {
      const m = by(run({ currentOverall: 20, gapToNextTurn: 12, adp }), "survival")?.magnitude ?? 0;
      expect(m).toBeLessThanOrEqual(previous + 1e-9);
      previous = m;
    }
  });

  it("is DISABLED at the owner's final pick, and reports nothing missing (FR-023)", () => {
    // gapToNextTurn === null means there is no next turn. The rule does not
    // apply; its absence is not a gap in the data. A naive implementation
    // substitutes a large number here and marks the whole board safe.
    const r = run({ gapToNextTurn: null, adp: 21 });
    expect(by(r, "survival")).toBeUndefined();
    expect(r.missingAdp).toBe(false);
  });

  it("uses the REAL gap at a snake turnaround, not an assumed round", () => {
    // Back-to-back picks: a gap of 1. A player whose ADP is 25 will not be
    // taken in one pick, so survival must be near-silent — whereas assuming a
    // round would shout.
    const turnaround = by(run({ currentOverall: 20, gapToNextTurn: 1, adp: 25 }), "survival");
    const fullRound = by(run({ currentOverall: 20, gapToNextTurn: 12, adp: 25 }), "survival");
    expect(turnaround?.magnitude ?? 0).toBeLessThan(fullRound!.magnitude);
  });

  it("still fires at a turnaround for someone going right now", () => {
    const r = run({ currentOverall: 20, gapToNextTurn: 1, adp: 19 });
    expect(by(r, "survival")!.magnitude).toBeGreaterThan(0);
  });
});

describe("slot_value (FR-005)", () => {
  it("rewards a player who has FALLEN past his ADP", () => {
    const r = run({ currentOverall: 40, adp: 20, gapToNextTurn: null });
    expect(by(r, "slot_value")!.magnitude).toBeGreaterThan(0);
    expect(by(r, "slot_value")!.reason).toMatch(/later than his average draft position/);
  });

  it("gives NO bonus for reaching — and no penalty either", () => {
    // Reaching earns nothing, but is not punished: the owner may have reasons
    // the engine cannot see, and a penalty would be a second opinion on a
    // decision they have not made yet.
    const r = run({ currentOverall: 10, adp: 40, gapToNextTurn: null });
    expect(by(r, "slot_value")).toBeUndefined();
    expect(r.adjustments.every((a) => a.magnitude >= 0)).toBe(true);
  });

  it("saturates — falling three rounds is not three times the bargain", () => {
    const two = by(run({ currentOverall: 44, adp: 20, gapToNextTurn: null }), "slot_value")!.magnitude;
    const five = by(run({ currentOverall: 80, adp: 20, gapToNextTurn: null }), "slot_value")!.magnitude;
    expect(five).toBeCloseTo(two, 5);
  });
});

describe("the shared clamp (research §4)", () => {
  it("stops a player collecting twice for ONE fact", () => {
    // EXACTLY the player the clamp exists for: fell two rounds past his ADP
    // (slot_value fires at full strength) and is certain to be gone before the
    // next turn (survival fires at full strength). Unclamped these sum to
    // 0.9 × ROUND_VALUE; the cap is 0.75.
    const r = run({ currentOverall: 44, adp: 20, gapToNextTurn: 12, teamCount: 12 });
    expect(by(r, "slot_value")).toBeDefined();
    expect(by(r, "survival")).toBeDefined();
    const total = r.adjustments.reduce((s, a) => s + Math.abs(a.magnitude), 0);
    expect(total).toBeLessThanOrEqual(ADP_COMBINED_CAP * ROUND + 1e-6);
  });

  it("scales BOTH rules rather than dropping one", () => {
    // Dropping one would be simpler and would satisfy the bound — and would
    // lose a reason the owner is entitled to (Constitution VII).
    const r = run({ currentOverall: 44, adp: 20, gapToNextTurn: 12, teamCount: 12 });
    expect(r.adjustments.map((a) => a.rule).sort()).toEqual(["slot_value", "survival"]);
    expect(r.adjustments.every((a) => a.magnitude > 0)).toBe(true);
  });

  it("leaves an uncontested single rule alone", () => {
    // The clamp must not quietly shrink a player who only triggered one rule.
    const r = run({ currentOverall: 20, adp: 21, gapToNextTurn: 12, teamCount: 12 });
    expect(r.adjustments).toHaveLength(1);
    const total = r.adjustments[0]!.magnitude;
    expect(total).toBeLessThanOrEqual(ADP_COMBINED_CAP * ROUND + 1e-6);
    expect(total).toBeGreaterThan(0);
  });

  it("holds for every combination the draft can produce", () => {
    const cap = ADP_COMBINED_CAP * ROUND + 1e-6;
    for (const currentOverall of [1, 20, 44, 80, 150]) {
      for (const adp of [1, 15, 40, 120, 171]) {
        for (const gapToNextTurn of [null, 1, 5, 12, 23]) {
          const r = run({ currentOverall, adp, gapToNextTurn });
          const total = r.adjustments.reduce((s, a) => s + Math.abs(a.magnitude), 0);
          expect(total, `overall=${currentOverall} adp=${adp} gap=${gapToNextTurn}`).toBeLessThanOrEqual(cap);
        }
      }
    }
  });
});

describe("degenerate inputs", () => {
  it("produces nothing when ROUND_VALUE has collapsed to zero", () => {
    // End of the draft: the board is flat, so a round is worth nothing and
    // every adjustment should be nothing too — not NaN.
    const r = run({ roundValue: 0 });
    expect(r.adjustments).toEqual([]);
  });

  it("never emits a NaN magnitude", () => {
    for (const gapToNextTurn of [null, 0, 1, 12]) {
      for (const roundValue of [0, 0.001, 100]) {
        const r = run({ gapToNextTurn, roundValue });
        expect(r.adjustments.every((a) => Number.isFinite(a.magnitude))).toBe(true);
      }
    }
  });

  it("treats a gap of 0 — already on the clock — as no survival question", () => {
    expect(by(run({ gapToNextTurn: 0 }), "survival")).toBeUndefined();
  });
});
