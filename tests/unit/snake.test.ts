// 005 T006 — snake order projection.
//
// The projection has to answer "who is on the clock" and "how many picks until
// mine" from a partially-observed draft. Two rules make it honest:
//
//  * BELOW the frontier, use what was observed. ESPN's published order is a
//    plan; the picks that actually happened are fact, and a projection that
//    overrides fact is worse than no projection.
//  * ABOVE it, project — but only while the order is trustworthy. With no
//    published order, `picksUntilTurn` must be NULL rather than a guess, or the
//    UI shows a countdown that is quietly wrong.

import { describe, expect, it } from "vitest";
import { picksUntilTurn, remainingSchedule, teamAt } from "../../src/draft/snake";

const ORDER = [5, 2, 1, 3, 6, 4]; // the real test league's non-identity order

describe("teamAt", () => {
  it("returns the published order in round 1", () => {
    for (let i = 0; i < ORDER.length; i++) {
      expect(teamAt({ order: ORDER, overall: i + 1, observed: new Map() })).toBe(ORDER[i]);
    }
  });

  it("REVERSES in round 2 — the serpentine, which is what distinguishes team id from pick number", () => {
    const reversed = [...ORDER].reverse();
    for (let i = 0; i < reversed.length; i++) {
      expect(teamAt({ order: ORDER, overall: 7 + i, observed: new Map() })).toBe(reversed[i]);
    }
  });

  it("returns to the published order in round 3", () => {
    expect(teamAt({ order: ORDER, overall: 13, observed: new Map() })).toBe(ORDER[0]);
  });

  it("prefers an OBSERVED team over the projection", () => {
    // The order ESPN published is a plan. A pick that actually happened is a
    // fact, and fact wins — otherwise a mid-draft order change silently
    // produces a board that disagrees with the draft room.
    const observed = new Map([[1, 99]]);
    expect(teamAt({ order: ORDER, overall: 1, observed })).toBe(99);
  });

  it("returns null when the order is unknown and nothing was observed", () => {
    expect(teamAt({ order: [], overall: 4, observed: new Map() })).toBeNull();
  });

  it("still answers from observation when the order is unknown", () => {
    expect(teamAt({ order: [], overall: 4, observed: new Map([[4, 12]]) })).toBe(12);
  });
});

describe("picksUntilTurn", () => {
  it("counts to the owner's next turn from the frontier", () => {
    // Frontier 1 (nothing picked). Team 1 sits at overall 3 ⇒ 2 picks away.
    expect(picksUntilTurn({ order: ORDER, frontier: 1, myTeamId: 1, observed: new Map() })).toBe(2);
  });

  it("returns 0 when the owner is on the clock", () => {
    expect(picksUntilTurn({ order: ORDER, frontier: 3, myTeamId: 1, observed: new Map() })).toBe(0);
  });

  it("handles back-to-back turns at the snake boundary", () => {
    // Team 4 picks overall 6 (end of round 1) and overall 7 (start of round 2).
    expect(teamAt({ order: ORDER, overall: 6, observed: new Map() })).toBe(4);
    expect(teamAt({ order: ORDER, overall: 7, observed: new Map() })).toBe(4);
    expect(picksUntilTurn({ order: ORDER, frontier: 7, myTeamId: 4, observed: new Map() })).toBe(0);
  });

  it("is NULL when the order is unknown — never a guess", () => {
    // A countdown that is quietly wrong is worse than a dash. FR-017.
    expect(picksUntilTurn({ order: [], frontier: 1, myTeamId: 1, observed: new Map() })).toBeNull();
  });

  it("is null once the owner has no turns left", () => {
    expect(
      picksUntilTurn({ order: ORDER, frontier: 73, myTeamId: 1, observed: new Map(), totalPicks: 72 }),
    ).toBeNull();
  });
});

describe("remainingSchedule", () => {
  it("lists the owner's future picks in order", () => {
    const s = remainingSchedule({ order: ORDER, frontier: 1, myTeamId: 1, totalPicks: 24 });
    expect(s).toEqual([3, 10, 15, 22]);
  });

  it("excludes picks already made", () => {
    const s = remainingSchedule({ order: ORDER, frontier: 11, myTeamId: 1, totalPicks: 24 });
    expect(s).toEqual([15, 22]);
  });

  it("is empty when the order is unknown", () => {
    expect(remainingSchedule({ order: [], frontier: 1, myTeamId: 1, totalPicks: 24 })).toEqual([]);
  });
});
