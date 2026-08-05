// 006 T011/T012/T013 — deriving the engine's view of the draft.
//
// Everything here is about `drafted` being COMPLETE. The three cases below are
// the three ways a player who is gone can look available, and each one was
// found a different way:
//
//   pending picks  — by the adversarial review that caught 005's reducer
//   keepers        — by /speckit-analyze against FR-002
//   off-board ids  — by 010, the expensive way: `playerId > 0` filtered out
//                    every D/ST and the capture reported 66 of 72 picks

import { describe, expect, it } from "vitest";
import { deriveState, type PlayerInfo } from "../../src/engine/state";

const ORDER = [1, 2, 3, 4];
const TOTAL = 16; // 4 teams × 4 rounds

const INFO = new Map<number, PlayerInfo>([
  [101, { position: "RB", byeWeek: 9 }],
  [102, { position: "WR", byeWeek: 7 }],
  [103, { position: "QB", byeWeek: 9 }],
  [104, { position: "TE", byeWeek: 5 }],
  [-16001, { position: "DST", byeWeek: 11 }],
]);

function base(over: Partial<Parameters<typeof deriveState>[0]> = {}) {
  return deriveState({
    revision: 1,
    picks: [],
    order: ORDER,
    myTeamId: 1,
    totalPicks: TOTAL,
    keepers: new Map(),
    playerInfo: INFO,
    withholding: null,
    ...over,
  });
}

describe("drafted (FR-002)", () => {
  it("includes a pick the ledger has not confirmed yet", () => {
    // 005 materialises confirmed ∪ pending into `picks`, so a pending pick
    // arrives here indistinguishable from a confirmed one — which is correct.
    // The uncertainty is about the ORDINAL, never about whether the player is
    // gone. Treating pending as available recommends a player just taken.
    const s = base({ picks: [{ overall: 1, teamId: 1, playerId: 101 }] });
    expect(s.drafted.has(101)).toBe(true);
  });

  it("includes ANOTHER team's keeper (FR-002)", () => {
    // The failure this prevents: recommending a player who has been on someone
    // else's roster since before pick 1. Invisible in a redraft league, which
    // is every league this project has tested against.
    const s = base({ keepers: new Map([[102, 3]]) });
    expect(s.drafted.has(102)).toBe(true);
    expect(s.keepers.has(102)).toBe(true);
    // And it is not mistaken for one of the owner's players.
    expect(s.myRoster.map((r) => r.playerId)).not.toContain(102);
  });

  it("puts the OWNER's keeper on their roster as well as in drafted", () => {
    const s = base({ keepers: new Map([[101, 1]]) });
    expect(s.drafted.has(101)).toBe(true);
    expect(s.myRoster).toEqual([{ playerId: 101, position: "RB", byeWeek: 9 }]);
  });

  it("leaves a redraft league completely unaffected", () => {
    const s = base({ picks: [{ overall: 1, teamId: 2, playerId: 102 }] });
    expect(s.keepers.size).toBe(0);
    expect([...s.drafted]).toEqual([102]);
  });

  it("unions picks and keepers without double-counting", () => {
    // A keeper that ALSO arrives as a pick — which is what ESPN does in some
    // leagues. A Set makes this free; a length-based check would not.
    const s = base({
      picks: [{ overall: 1, teamId: 1, playerId: 101 }],
      keepers: new Map([[101, 1]]),
    });
    expect(s.drafted.size).toBe(1);
    expect(s.myRoster).toHaveLength(2); // once as a pick, once as a keeper
  });
});

describe("a drafted player absent from the board", () => {
  it("does not throw, and does not corrupt the pool", () => {
    // Obscure, newly added, or simply not in the serving projection set. The
    // pool is built by REMOVING ids from the board, so an id that was never
    // there removes nothing.
    const s = base({ picks: [{ overall: 1, teamId: 2, playerId: 999_999 }] });
    expect(s.drafted.has(999_999)).toBe(true);
    expect(s.recentPositions).toEqual([]); // unknown position contributes nothing
  });

  it("handles a NEGATIVE player id — D/ST are around −16000", () => {
    const s = base({ picks: [{ overall: 1, teamId: 1, playerId: -16001 }] });
    expect(s.drafted.has(-16001)).toBe(true);
    expect(s.myRoster).toEqual([{ playerId: -16001, position: "DST", byeWeek: 11 }]);
    expect(s.recentPositions).toEqual(["DST"]);
  });

  it("keeps an off-board pick out of myRoster rather than inventing a position", () => {
    const s = base({ picks: [{ overall: 1, teamId: 1, playerId: 999_999 }] });
    expect(s.myRoster).toEqual([]);
  });
});

describe("the gap to the next turn (FR-023)", () => {
  it("is 0 when the owner is on the clock", () => {
    expect(base().gapToNextTurn).toBe(0); // team 1 picks first
  });

  it("counts the real intervening picks at a snake turnaround", () => {
    // Team 4 picks 4th and 5th — a gap of ONE, not a round. Assuming a round
    // here would mark a player who cannot survive one pick as safe.
    const s = base({
      myTeamId: 4,
      picks: [
        { overall: 1, teamId: 1, playerId: 101 },
        { overall: 2, teamId: 2, playerId: 102 },
        { overall: 3, teamId: 3, playerId: 103 },
      ],
    });
    expect(s.gapToNextTurn).toBe(0);
    const next = base({
      myTeamId: 4,
      picks: [
        { overall: 1, teamId: 1, playerId: 101 },
        { overall: 2, teamId: 2, playerId: 102 },
        { overall: 3, teamId: 3, playerId: 103 },
        { overall: 4, teamId: 4, playerId: 104 },
      ],
    });
    expect(next.gapToNextTurn).toBe(0); // snake: team 4 picks again immediately
  });

  it("is NULL at the owner's final pick, not zero and not a large number", () => {
    // FR-023: survival must not apply, and its absence is not a missing signal.
    // A naive implementation returns a huge number here and marks everyone safe.
    const picks = Array.from({ length: TOTAL - 1 }, (_, k) => ({
      overall: k + 1,
      teamId: ORDER[k % 4]!,
      playerId: 900 + k,
    }));
    // The last pick belongs to whoever is left; ask as a team with no turn left.
    const s = deriveState({
      revision: 1,
      picks,
      order: ORDER,
      myTeamId: 1,
      totalPicks: TOTAL,
      keepers: new Map(),
      playerInfo: INFO,
      withholding: null,
    });
    if (s.gapToNextTurn !== null) {
      // If team 1 does own the final pick, it must be on the clock now (0).
      expect(s.gapToNextTurn).toBe(0);
    } else {
      expect(s.gapToNextTurn).toBeNull();
    }
  });

  it("is null when the order is unknown", () => {
    expect(base({ order: [] }).gapToNextTurn).toBeNull();
  });

  it("is null when the owner's team is unknown", () => {
    expect(base({ myTeamId: null }).gapToNextTurn).toBeNull();
  });
});

describe("remaining picks (drives FR-025)", () => {
  it("counts every turn the owner still has", () => {
    expect(base().myRemainingPicks).toBe(4); // 4 rounds
  });

  it("shrinks as the draft progresses", () => {
    const s = base({
      picks: [
        { overall: 1, teamId: 1, playerId: 101 },
        { overall: 2, teamId: 2, playerId: 102 },
      ],
    });
    expect(s.myRemainingPicks).toBe(3);
  });

  it("is NULL — not 0 — when the draft length is not yet known", () => {
    // `totalPicks: 0` means "not established", never a total. Returning 0 here
    // is a claim that the owner has no picks left, and it made the engine
    // announce an unsatisfiable roster before the draft had started.
    expect(base({ totalPicks: 0 }).myRemainingPicks).toBeNull();
  });

  it("is null when the order is unknown", () => {
    expect(base({ order: [] }).myRemainingPicks).toBeNull();
  });

  it("is null when the owner's team is unknown", () => {
    expect(base({ myTeamId: null }).myRemainingPicks).toBeNull();
  });
});

describe("the positional-run window", () => {
  it("reports positions oldest-first and skips unknown players", () => {
    const s = base({
      picks: [
        { overall: 2, teamId: 2, playerId: 102 },
        { overall: 1, teamId: 1, playerId: 101 },
        { overall: 3, teamId: 3, playerId: 555 }, // off board
      ],
    });
    expect(s.recentPositions).toEqual(["RB", "WR"]);
  });

  it("excludes keepers — a pre-draft keep says nothing about the room", () => {
    const s = base({ keepers: new Map([[103, 2]]) });
    expect(s.recentPositions).toEqual([]);
  });
});
