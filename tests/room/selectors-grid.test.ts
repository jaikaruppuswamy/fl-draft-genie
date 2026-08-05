// 007 T008 — the STRUCTURAL selectors, which are foundational.
//
// `boardGrid()` and `rosterView()` live in Phase 2, not US2, because US3's grid,
// US3's roster panel and US4's completed summary all need them. An earlier plan
// put the whole selector module in US2 while claiming US2/US3/US4 were mutually
// independent — which was false, and `/speckit-analyze` caught it.

import { describe, expect, it } from "vitest";
import { boardGrid, rosterView, type PlayerLookup } from "../../web/src/lib/draftRoomSelectors";
import { armed, lookup } from "./helpers";

const PLAYERS = lookup([
  [100, { name: "Ash Rivers", position: "RB", team: "SF" }],
  [200, { name: "Bo Canyon", position: "WR", team: "KC" }],
  [300, { name: "Cy Meadow", position: "TE", team: "BUF" }],
  [-16001, { name: "Bears D/ST", position: "DST", team: "CHI" }],
]);

const ORDER = [1, 2, 3, 4, 5, 6];

describe("boardGrid", () => {
  it("lays out rounds × teams with sequential overall numbers", () => {
    const grid = boardGrid(armed({ order: ORDER }), PLAYERS, 6, 3);
    expect(grid.rounds).toHaveLength(3);
    expect(grid.rounds[0]!.cells).toHaveLength(6);
    expect(grid.rounds[0]!.cells.map((c) => c.overall)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(grid.rounds[1]!.cells.map((c) => c.overall)).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("labels cells round.pick", () => {
    const grid = boardGrid(armed({ order: ORDER }), PLAYERS, 6, 2);
    expect(grid.rounds[0]!.cells[0]!.label).toBe("1.01");
    expect(grid.rounds[1]!.cells[5]!.label).toBe("2.06");
  });

  it("snakes: even rounds run right to left", () => {
    // Derived from the ROUND, never from a field on the pick — 010's oracle
    // disproved the field-3-is-the-round reading at 5 of 70.
    const grid = boardGrid(armed({ order: ORDER }), PLAYERS, 6, 2);
    expect(grid.rounds[0]!.cells.map((c) => c.teamId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(grid.rounds[1]!.cells.map((c) => c.teamId)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("places a pick's player into its cell", () => {
    const state = armed({ order: ORDER, picks: [{ overall: 2, teamId: 2, playerId: 100 }] });
    const grid = boardGrid(state, PLAYERS, 6, 1);
    expect(grid.rounds[0]!.cells[1]!.player?.name).toBe("Ash Rivers");
    expect(grid.rounds[0]!.cells[0]!.player).toBeNull();
  });

  it("renders an UNKNOWN player id as a placeholder rather than throwing", () => {
    // A drafted player may be absent from the board entirely — obscure, newly
    // added, or simply not in the serving projection set.
    const state = armed({ order: ORDER, picks: [{ overall: 1, teamId: 1, playerId: 999_999 }] });
    const grid = boardGrid(state, PLAYERS, 6, 1);
    expect(grid.rounds[0]!.cells[0]!.player).toBeNull();
    expect(grid.rounds[0]!.cells[0]!.teamId).toBe(1);
  });

  it("handles a NEGATIVE player id — D/ST sit around −16000", () => {
    // `playerId > 0` filtering is what made 010's capture report 66 of 72.
    const state = armed({ order: ORDER, picks: [{ overall: 1, teamId: 1, playerId: -16001 }] });
    const grid = boardGrid(state, PLAYERS, 6, 1);
    expect(grid.rounds[0]!.cells[0]!.player?.name).toBe("Bears D/ST");
  });

  it("marks the owner's column", () => {
    const state = armed({ order: ORDER, myTeamId: 3 });
    const grid = boardGrid(state, PLAYERS, 6, 2);
    expect(grid.rounds[0]!.cells.filter((c) => c.mine).map((c) => c.overall)).toEqual([3]);
    expect(grid.rounds[1]!.cells.filter((c) => c.mine).map((c) => c.overall)).toEqual([10]);
  });

  it("marks the current pick, and only one", () => {
    const state = armed({ order: ORDER, picks: [{ overall: 1, teamId: 1, playerId: 100 }] });
    const grid = boardGrid(state, PLAYERS, 6, 2);
    const current = grid.rounds.flatMap((r) => r.cells).filter((c) => c.current);
    expect(current.map((c) => c.overall)).toEqual([2]);
  });

  it("does not invent a team when the order is unpublished", () => {
    // FR-017: `order === null` must never be papered over with a guess.
    const grid = boardGrid(armed({ order: null }), PLAYERS, 6, 1);
    expect(grid.rounds[0]!.cells.every((c) => c.teamId === 0)).toBe(true);
  });

  it("is deterministic", () => {
    const state = armed({ order: ORDER, picks: [{ overall: 4, teamId: 4, playerId: 200 }] });
    expect(JSON.stringify(boardGrid(state, PLAYERS, 6, 3))).toBe(
      JSON.stringify(boardGrid(state, PLAYERS, 6, 3)),
    );
  });
});

describe("rosterView", () => {
  const mine = armed({
    myTeamId: 1,
    picks: [
      { overall: 1, teamId: 1, playerId: 100 },
      { overall: 2, teamId: 2, playerId: 200 },
      { overall: 13, teamId: 1, playerId: 300 },
    ],
  });

  it("collects only the owner's players", () => {
    const view = rosterView(mine, PLAYERS);
    const names = view.slots.flatMap((s) => s.players.map((p) => p.name));
    expect(names.sort()).toEqual(["Ash Rivers", "Cy Meadow"]);
  });

  it("groups by position, in a stable order", () => {
    const view = rosterView(mine, PLAYERS);
    expect(view.slots.map((s) => s.position)).toEqual(["RB", "TE"]);
  });

  it("takes what is still needed from 006's WARNINGS, not a local recomputation", () => {
    // Recomputing roster requirements here would be a second implementation of
    // a rule 006 owns — and the two would disagree the day one changed.
    const withBoard = armed({
      myTeamId: 1,
      recommendation: {
        warnings: [{ kind: "mandatory_unfilled", detail: "K, DST still unfilled, 4 picks left" }],
        forced: false,
      } as never,
    });
    expect(rosterView(withBoard, PLAYERS).stillNeeded).toBe("K, DST still unfilled, 4 picks left");
  });

  it("surfaces the unsatisfiable warning too", () => {
    const doomed = armed({
      myTeamId: 1,
      recommendation: {
        warnings: [{ kind: "mandatory_unsatisfiable", detail: "cannot be completed" }],
        forced: true,
      } as never,
    });
    const view = rosterView(doomed, PLAYERS);
    expect(view.stillNeeded).toBe("cannot be completed");
    expect(view.forced).toBe(true);
  });

  it("reports nothing needed when there is no board yet", () => {
    expect(rosterView(armed({ myTeamId: 1 }), PLAYERS).stillNeeded).toBeNull();
  });

  it("skips an unknown player rather than inventing a position", () => {
    const odd = armed({ myTeamId: 1, picks: [{ overall: 1, teamId: 1, playerId: 424_242 }] });
    expect(rosterView(odd, PLAYERS).slots).toEqual([]);
  });

  it("is empty when the owner's team is unknown", () => {
    expect(rosterView(armed({ myTeamId: null }), PLAYERS).slots).toEqual([]);
  });
});
