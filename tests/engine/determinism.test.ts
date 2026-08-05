// 006 T027 — SC-003 and FR-017.
//
// Determinism is asserted TWICE, in two different ways, because they fail
// differently:
//
//   * behaviourally — two runs over identical arguments serialise identically;
//   * structurally  — the exported signature takes no clock and no environment.
//
// The behavioural test alone would pass on an engine that reads `Date.now()`
// once per process and caches it. The structural test alone would pass on an
// engine that sorts unstably. 005's `stateFingerprint` needed both for the same
// reason, and the lesson generalises.

import { describe, expect, it } from "vitest";
import { recommend } from "../../src/engine/recommend";
import { makeBundle, makeState, boardEntry, ROSTER, TEAM_COUNT } from "./helpers";

describe("SC-003 — identical inputs, identical output", () => {
  it("serialises byte for byte across two runs", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 37 });
    const a = recommend(bundle, state);
    const b = recommend(bundle, state);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is stable across many runs, not just two", () => {
    // A cached-clock bug can survive a two-run comparison; a hash set cannot.
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 12 });
    const shapes = new Set(Array.from({ length: 8 }, () => JSON.stringify(recommend(bundle, state))));
    expect(shapes.size).toBe(1);
  });

  it("does not depend on the order players arrive in", () => {
    // The board comes out of D1 in whatever order the query yields. If the
    // ranking depends on that, the output is stable within a run and unstable
    // across deploys — the worst possible combination, because it looks fine.
    const bundle = makeBundle();
    const reversed = makeBundle({ players: [...bundle.players].reverse() });
    reversed.proTeamByPlayer = bundle.proTeamByPlayer;
    const a = recommend(bundle, makeState(bundle, { picksMade: 20 }));
    const b = recommend(reversed, makeState(reversed, { picksMade: 20 }));
    expect(a.entries.map((e) => e.playerId)).toEqual(b.entries.map((e) => e.playerId));
  });
});

describe("FR-017 — the ordering is total", () => {
  it("orders players identical on EVERY input deterministically", () => {
    // Two players the engine cannot tell apart in any way except their id.
    const twins = [
      boardEntry({ id: 501, position: "RB", points: 100, adp: 10, bye: 7, proTeam: 3, name: "Same Name" }),
      boardEntry({ id: 502, position: "RB", points: 100, adp: 10, bye: 7, proTeam: 3, name: "Same Name" }),
    ];
    const bundle = makeBundle({ players: [...twins, ...makeBundle().players] });
    const state = makeState(bundle, { picksMade: 0 });

    const first = recommend(bundle, state).entries;
    const second = recommend(bundle, state).entries;
    const rankOf = (list: typeof first, id: number) => list.find((e) => e.playerId === id)!.rank;
    expect(rankOf(first, 501)).toBe(rankOf(second, 501));
    expect(rankOf(first, 502)).toBe(rankOf(second, 502));
    // And the lower id comes first, since nothing else separates them.
    expect(rankOf(first, 501)).toBeLessThan(rankOf(first, 502));
  });

  it("assigns every available player a distinct, contiguous rank", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 30 });
    const board = recommend(bundle, state);
    const ranks = board.entries.map((e) => e.rank);
    expect(ranks).toEqual(Array.from({ length: board.entries.length }, (_, i) => i + 1));
    expect(new Set(board.entries.map((e) => e.playerId)).size).toBe(board.entries.length);
  });

  it("ranks EVERY available player, not just the valued ones (FR-001)", () => {
    const withUnprojected = [
      ...makeBundle().players,
      boardEntry({ id: 9001, position: "WR", points: null }),
      boardEntry({ id: 9002, position: "RB", points: null }),
    ];
    const bundle = makeBundle({ players: withUnprojected });
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    expect(board.entries).toHaveLength(withUnprojected.length);
    // …but they sort last, behind every player carrying a value.
    const tail = board.entries.slice(-2).map((e) => e.playerId).sort();
    expect(tail).toEqual([9001, 9002]);
  });
});

describe("purity, as a property of the signature", () => {
  it("takes exactly two arguments — no env, no clock, no options bag", () => {
    // A third parameter is how a `now` sneaks in, and the day it does,
    // SC-010's "reproducible from the archive alone" quietly stops being true.
    expect(recommend.length).toBe(2);
  });

  it("does not mutate its arguments", () => {
    // The engine is called repeatedly across a draft with the same bundle.
    // A mutation would make run N depend on runs 1..N−1, which is
    // non-determinism wearing a very convincing disguise.
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 15 });
    const bundleBefore = JSON.stringify(bundle.players);
    const draftedBefore = [...state.drafted].sort((a, b) => a - b);
    recommend(bundle, state);
    expect(JSON.stringify(bundle.players)).toBe(bundleBefore);
    expect([...state.drafted].sort((a, b) => a - b)).toEqual(draftedBefore);
  });

  it("produces the same answer regardless of how many times it has been called", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 5 });
    const first = JSON.stringify(recommend(bundle, state));
    for (let i = 0; i < 5; i++) recommend(bundle, makeState(bundle, { picksMade: i }));
    expect(JSON.stringify(recommend(bundle, state))).toBe(first);
  });
});

describe("the roster shape reaches the ordering", () => {
  it("changes the ranking when the league starts different positions", () => {
    // Guards against a baseline that ignores `roster` — which would still pass
    // every determinism test above while quietly breaking Constitution II.
    const bundle = makeBundle();
    const superflex = makeBundle({
      roster: { ...ROSTER, slots: [...ROSTER.slots, { slotId: 7, label: "OP", count: 1 }] },
    });
    superflex.players = bundle.players;
    superflex.proTeamByPlayer = bundle.proTeamByPlayer;
    const a = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const b = recommend(superflex, makeState(superflex, { picksMade: 0 }));
    expect(a.entries.slice(0, 20).map((e) => e.playerId)).not.toEqual(
      b.entries.slice(0, 20).map((e) => e.playerId),
    );
  });

  it("uses the league's team count", () => {
    const twelve = makeBundle();
    const eight = makeBundle({ teamCount: 8 });
    eight.players = twelve.players;
    eight.proTeamByPlayer = twelve.proTeamByPlayer;
    expect(recommend(eight, makeState(eight, { picksMade: 0 })).roundValue).not.toBe(
      recommend(twelve, makeState(twelve, { picksMade: 0 })).roundValue,
    );
    expect(TEAM_COUNT).toBe(12);
  });
});
