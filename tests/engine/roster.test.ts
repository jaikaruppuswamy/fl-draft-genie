// 006 T024 — FR-025, tested on BOTH sides of the boundary.
//
// One side is the interesting one. It is easy to write a test proving the
// engine forces a kicker when it must, and never notice that it also forces one
// three rounds early. The boundary is the whole rule: while remaining picks
// EXCEED unfilled mandatory slots, nothing is forced and nothing is weighted;
// the moment they are EQUAL, everything is.

import { describe, expect, it } from "vitest";
import { fillsNeed, mandatoryWarning, rosterStatus } from "../../src/engine/roster";
import type { RosteredPlayer } from "../../src/engine/types";
import type { RosterSnapshot } from "../../src/espn/parsers";

/** QB1 RB2 WR2 TE1 FLEX1 K1 DST1 + bench — 8 mandatory slots. */
const ROSTER: RosterSnapshot = {
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

function have(...positions: string[]): RosteredPlayer[] {
  return positions.map((position, i) => ({ playerId: i + 1, position, byeWeek: null }));
}

/** Everything except a kicker — one mandatory slot left. */
const ALL_BUT_K = have("QB", "RB", "RB", "WR", "WR", "TE", "DST");

describe("counting what is still required", () => {
  it("counts only position-specific slots — FLEX can never go unfilled", () => {
    const s = rosterStatus(ROSTER, [], 16);
    expect(s.unfilledMandatory).toBe(8); // 1+2+2+1+1+1
    expect(s.needs.map((n) => n.position)).toEqual(["DST", "K", "QB", "RB", "TE", "WR"]);
  });

  it("excludes bench and IR", () => {
    const withIr: RosterSnapshot = {
      ...ROSTER,
      slots: [...ROSTER.slots, { slotId: 21, label: "IR", count: 2 }],
    };
    expect(rosterStatus(withIr, [], 16).unfilledMandatory).toBe(8);
  });

  it("does not let a surplus at one position cover another", () => {
    // Three running backs do not fill a missing kicker. A naive "count my
    // players against my slots" gets this wrong and declares the roster done.
    const s = rosterStatus(ROSTER, have("RB", "RB", "RB", "RB"), 10);
    expect(s.needs.find((n) => n.position === "RB")!.unfilled).toBe(0);
    expect(s.neededPositions.has("K")).toBe(true);
    expect(s.unfilledMandatory).toBe(6); // QB WR WR TE K DST
  });

  it("normalises D/ST to DST", () => {
    const s = rosterStatus(ROSTER, have("D/ST"), 10);
    expect(s.needs.find((n) => n.position === "DST")!.owned).toBe(1);
  });
});

describe("the boundary (FR-025)", () => {
  it("does NOT force while picks remaining EXCEED unfilled slots", () => {
    // One slot left (K), two picks. The honest answer is still the best player.
    const s = rosterStatus(ROSTER, ALL_BUT_K, 2);
    expect(s.unfilledMandatory).toBe(1);
    expect(s.forced).toBe(false);
    expect(s.unsatisfiable).toBe(false);
  });

  it("DOES force once they are equal", () => {
    const s = rosterStatus(ROSTER, ALL_BUT_K, 1);
    expect(s.forced).toBe(true);
    expect(fillsNeed("K", s)).toBe(true);
    expect(fillsNeed("RB", s)).toBe(false);
  });

  it("still warns on the un-forced side — the owner is told, just not overruled", () => {
    const s = rosterStatus(ROSTER, ALL_BUT_K, 2);
    expect(mandatoryWarning(s)).toBe("K still unfilled, 2 picks left");
  });

  it("warns in the singular at one pick", () => {
    expect(mandatoryWarning(rosterStatus(ROSTER, ALL_BUT_K, 1))).toBe("K still unfilled, 1 pick left");
  });

  it("forces with SEVERAL slots left and exactly that many picks", () => {
    const s = rosterStatus(ROSTER, have("QB", "RB", "RB", "WR", "WR", "TE"), 2);
    expect(s.unfilledMandatory).toBe(2); // K and DST
    expect(s.forced).toBe(true);
    expect(fillsNeed("K", s)).toBe(true);
    expect(fillsNeed("DST", s)).toBe(true);
    expect(fillsNeed("WR", s)).toBe(false);
  });

  it("does not force a kicker three rounds early — the failure mode this rule exists to avoid", () => {
    for (const picksLeft of [2, 3, 5, 9]) {
      expect(rosterStatus(ROSTER, ALL_BUT_K, picksLeft).forced, `${picksLeft} picks left`).toBe(false);
    }
  });
});

describe("the roster is complete", () => {
  it("forces nothing when every mandatory slot is filled", () => {
    const full = have("QB", "RB", "RB", "WR", "WR", "TE", "K", "DST");
    const s = rosterStatus(ROSTER, full, 4);
    expect(s.unfilledMandatory).toBe(0);
    expect(s.forced).toBe(false);
    expect(s.neededPositions.size).toBe(0);
    expect(mandatoryWarning(s)).toBeNull();
  });

  it("forces nothing when the roster is complete AND no picks remain", () => {
    const full = have("QB", "RB", "RB", "WR", "WR", "TE", "K", "DST");
    expect(rosterStatus(ROSTER, full, 0).forced).toBe(false);
  });
});

describe("already unsatisfiable", () => {
  it("says so rather than pretending the roster can still be completed", () => {
    // Two slots, one pick. The engine must not quietly recommend as though
    // this were fine — the owner has a decision to make about which to lose.
    const s = rosterStatus(ROSTER, have("QB", "RB", "RB", "WR", "WR", "TE"), 1);
    expect(s.unfilledMandatory).toBe(2);
    expect(s.unsatisfiable).toBe(true);
  });

  it("is unsatisfiable with slots left and NO picks at all", () => {
    const s = rosterStatus(ROSTER, ALL_BUT_K, 0);
    expect(s.unsatisfiable).toBe(true);
    // And nothing is "forced" — there is nothing left to force.
    expect(s.forced).toBe(false);
  });
});

describe("determinism (FR-017)", () => {
  it("orders needs and warnings identically across calls", () => {
    const a = rosterStatus(ROSTER, have("RB"), 8);
    const b = rosterStatus(ROSTER, have("RB"), 8);
    expect(a.needs).toEqual(b.needs);
    expect(mandatoryWarning(a)).toBe(mandatoryWarning(b));
    // RB is still listed: one owned against a requirement of two.
    expect(mandatoryWarning(a)).toBe("DST, K, QB, RB, TE, WR still unfilled, 8 picks left");
  });
});
