// 006 T014/T015 — replacement level, and the FLEX allocation.
//
// The FLEX test is the one that matters most. Constitution III says every
// number must be computed in the league's own scoring, and the easy way to
// satisfy that on paper while breaking it in practice is a fixed flex split —
// "flex is 60% RB" — which is a guess about a typical league wearing the
// costume of a derivation. Allocating flex BY VALUE makes a PPR league move its
// own baselines with no setting changing, and that is what the test asserts.

import { describe, expect, it } from "vitest";
import { computeBaselines, valueOf } from "../../src/engine/value";
import type { BoardEntry } from "../../src/projections/scoring";
import type { RosterSnapshot } from "../../src/espn/parsers";

function player(id: number, position: string, points: number | null): BoardEntry {
  return {
    espn_player_id: id,
    name: `P${id}`,
    position,
    eligible_positions: [position],
    team: "XX",
    bye_week: null,
    projected_points: points,
    position_rank: null,
    adp: null,
    overall_rank: null,
  };
}

/** QB1 RB2 WR2 TE1 FLEX1 K1 DST1, plus bench. */
const STANDARD_ROSTER: RosterSnapshot = {
  slots: [
    { slotId: 0, label: "QB", count: 1 },
    { slotId: 2, label: "RB", count: 2 },
    { slotId: 4, label: "WR", count: 2 },
    { slotId: 6, label: "TE", count: 1 },
    { slotId: 23, label: "FLEX", count: 1 },
    { slotId: 16, label: "D/ST", count: 1 },
    { slotId: 17, label: "K", count: 1 },
    { slotId: 20, label: "Bench", count: 6 },
  ],
  starting_slots: 9,
  bench_slots: 6,
};

/** A descending run of points, so ranks are unambiguous. */
function pool(position: string, n: number, top: number, step: number, idBase: number): BoardEntry[] {
  return Array.from({ length: n }, (_, i) => player(idBase + i, position, top - i * step));
}

describe("replacement level (FR-004)", () => {
  it("baselines each position at its league-wide starter boundary", () => {
    // 2 teams × 2 RB starters = 4, plus the flex, which the best remaining
    // player wins. RBs run 100, 96, 92, … so the 4th is 88.
    const players = [
      ...pool("RB", 8, 100, 4, 100),
      ...pool("WR", 8, 60, 2, 200),
      ...pool("QB", 4, 50, 5, 300),
      ...pool("TE", 4, 40, 5, 400),
      ...pool("K", 4, 20, 1, 500),
      ...pool("DST", 4, 18, 1, 600),
    ];
    const b = computeBaselines(players, STANDARD_ROSTER, 2);
    expect(b.boundary.get("QB")).toBe(2); // 2 teams × 1
    expect(b.boundary.get("TE")).toBe(2);
    expect(b.boundary.get("K")).toBe(2);
    expect(b.boundary.get("DST")).toBe(2);
    // 2 teams × (2 RB + 2 WR + 1 TE) dedicated = 10, plus 2 × 1 flex = 12.
    expect((b.boundary.get("RB") ?? 0) + (b.boundary.get("WR") ?? 0) + (b.boundary.get("TE") ?? 0)).toBe(12);
    // The RB baseline is the last RB starter, not the first bench RB.
    const rbBoundary = b.boundary.get("RB")!;
    expect(b.replacement.get("RB")).toBe(100 - (rbBoundary - 1) * 4);
  });

  it("values a player as points ABOVE their position's replacement", () => {
    const players = [...pool("RB", 6, 100, 10, 100), ...pool("WR", 6, 100, 10, 200)];
    const b = computeBaselines(players, STANDARD_ROSTER, 1);
    const top = players[0]!;
    expect(valueOf(top, b)).toBe(100 - b.replacement.get("RB")!);
  });

  it("baselines a position with ZERO starter slots at its own best player", () => {
    // A league with no kicker slot. Every K then values at <= 0 and can never
    // outrank a usable player — which is the correct answer, not a special case.
    const noKicker: RosterSnapshot = {
      ...STANDARD_ROSTER,
      slots: STANDARD_ROSTER.slots.filter((s) => s.slotId !== 17),
    };
    const players = [...pool("RB", 6, 100, 5, 100), ...pool("K", 4, 30, 1, 500)];
    const b = computeBaselines(players, noKicker, 2);
    expect(b.boundary.get("K") ?? 0).toBe(0);
    expect(b.replacement.get("K")).toBe(30); // the best K
    expect(valueOf(players.find((p) => p.position === "K")!, b)).toBe(0);
  });

  it("baselines a SHORT pool at its worst projected player", () => {
    // 4 teams need 8 starting RBs but only 3 exist. Indexing past the end is
    // the naive crash; clamping to the last is the honest answer.
    const players = [...pool("RB", 3, 100, 10, 100), ...pool("WR", 20, 90, 2, 200)];
    const b = computeBaselines(players, STANDARD_ROSTER, 4);
    expect(b.replacement.get("RB")).toBe(80); // the 3rd and worst
  });

  it("gives unprojected players no value at all", () => {
    const players = [...pool("RB", 4, 100, 5, 100), player(999, "RB", null)];
    const b = computeBaselines(players, STANDARD_ROSTER, 1);
    expect(valueOf(player(999, "RB", null), b)).toBeNull();
  });

  it("ignores unprojected players when computing the boundary", () => {
    // 504 of the 1026-player universe carry no projection. If they counted
    // toward the boundary they would drag every baseline to nothing.
    const withNulls = [
      ...pool("RB", 6, 100, 5, 100),
      ...Array.from({ length: 50 }, (_, i) => player(9000 + i, "RB", null)),
    ];
    const a = computeBaselines(pool("RB", 6, 100, 5, 100), STANDARD_ROSTER, 2);
    const b = computeBaselines(withNulls, STANDARD_ROSTER, 2);
    expect(b.replacement.get("RB")).toBe(a.replacement.get("RB"));
  });

  it("is deterministic across repeated calls", () => {
    const players = [...pool("RB", 8, 100, 4, 100), ...pool("WR", 8, 99, 4, 200)];
    const a = computeBaselines(players, STANDARD_ROSTER, 3);
    const b = computeBaselines(players, STANDARD_ROSTER, 3);
    expect([...a.replacement.entries()].sort()).toEqual([...b.replacement.entries()].sort());
  });
});

describe("the value-greedy FLEX allocation (Constitution III made testable)", () => {
  // One pool, two scorings. Under PPR the receivers score more, so more of them
  // should cross the starter boundary through the flex — with NO setting
  // changing anywhere. A fixed flex split cannot produce this.
  function poolFor(receptionBoost: number): BoardEntry[] {
    return [
      // RBs are unaffected by reception scoring in this fixture.
      ...pool("RB", 12, 100, 3, 100),
      // WRs gain `receptionBoost` under PPR.
      ...Array.from({ length: 12 }, (_, i) => player(200 + i, "WR", 88 - i * 3 + receptionBoost)),
      ...pool("TE", 8, 60, 3, 300),
      ...pool("QB", 6, 70, 4, 400),
      ...pool("K", 6, 20, 1, 500),
      ...pool("DST", 6, 18, 1, 600),
    ];
  }

  /** RB2 WR2 TE1 + THREE flex — enough flex for the allocation to visibly move. */
  const FLEX_HEAVY: RosterSnapshot = {
    ...STANDARD_ROSTER,
    slots: [...STANDARD_ROSTER.slots.filter((s) => s.slotId !== 23), { slotId: 23, label: "FLEX", count: 3 }],
  };

  it("pulls MORE receivers across the boundary under PPR", () => {
    const standard = computeBaselines(poolFor(0), FLEX_HEAVY, 2);
    const ppr = computeBaselines(poolFor(30), FLEX_HEAVY, 2);
    expect(ppr.boundary.get("WR")!).toBeGreaterThan(standard.boundary.get("WR")!);
    // And correspondingly fewer running backs.
    expect(ppr.boundary.get("RB")!).toBeLessThan(standard.boundary.get("RB")!);
  });

  it("moves the replacement baselines, not just the counts", () => {
    const standard = computeBaselines(poolFor(0), FLEX_HEAVY, 2);
    const ppr = computeBaselines(poolFor(30), FLEX_HEAVY, 2);
    expect(ppr.replacement.get("WR")).not.toBe(standard.replacement.get("WR"));
  });

  it("fills every flex slot when eligible players exist", () => {
    const b = computeBaselines(poolFor(0), FLEX_HEAVY, 2);
    const flexEligible = (b.boundary.get("RB") ?? 0) + (b.boundary.get("WR") ?? 0) + (b.boundary.get("TE") ?? 0);
    // 2 teams × (2 RB + 2 WR + 1 TE dedicated) = 10, plus 2 × 3 flex = 6.
    expect(flexEligible).toBe(16);
  });

  it("never lets a flex slot absorb an INELIGIBLE position", () => {
    // A kicker must not be counted as a flex starter no matter how it scores.
    const silly = [
      ...pool("K", 20, 500, 1, 500), // absurdly valuable kickers
      ...pool("RB", 8, 50, 2, 100),
      ...pool("WR", 8, 50, 2, 200),
      ...pool("TE", 8, 50, 2, 300),
      ...pool("QB", 4, 50, 2, 400),
      ...pool("DST", 4, 10, 1, 600),
    ];
    const b = computeBaselines(silly, FLEX_HEAVY, 2);
    expect(b.boundary.get("K")).toBe(2); // its dedicated slots only
  });

  it("respects a RESTRICTED flex — RB/WR cannot take a tight end", () => {
    const rbWrOnly: RosterSnapshot = {
      ...STANDARD_ROSTER,
      slots: [...STANDARD_ROSTER.slots.filter((s) => s.slotId !== 23), { slotId: 3, label: "RB/WR", count: 2 }],
    };
    // Tight ends are the most valuable players on the board, but slot 3 cannot
    // take them, so TE's boundary stays at its dedicated count.
    const teHeavy = [
      ...pool("TE", 10, 200, 2, 300),
      ...pool("RB", 10, 50, 2, 100),
      ...pool("WR", 10, 50, 2, 200),
      ...pool("QB", 4, 50, 2, 400),
      ...pool("K", 4, 20, 1, 500),
      ...pool("DST", 4, 18, 1, 600),
    ];
    const b = computeBaselines(teHeavy, rbWrOnly, 2);
    expect(b.boundary.get("TE")).toBe(2); // 2 teams × 1 dedicated, no flex
  });
});
