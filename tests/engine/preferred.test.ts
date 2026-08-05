// 006 T040 — SC-006, the bounded preferred boost.
//
// The bound is measured FROM THE ADJUSTMENT'S OWN RECORDED MAGNITUDE, not by
// diffing two rankings. That matters: a diff would pass on an engine that
// applied a huge boost and happened to produce a similar order, and it would
// fail spuriously whenever some other rule moved in the same run.

import { describe, expect, it } from "vitest";
import { recommend } from "../../src/engine/recommend";
import { preferredAdjustment } from "../../src/engine/preferred";
import { PREFERRED_CAP } from "../../src/engine/constants";
import { makeBundle, makeState } from "./helpers";

describe("the boost is bounded (SC-006)", () => {
  it("never exceeds PREFERRED_CAP × ROUND_VALUE", () => {
    const bundle = makeBundle();
    bundle.preferred = new Set(bundle.players.slice(0, 60).map((p) => p.espn_player_id));
    const board = recommend(bundle, makeState(bundle, { picksMade: 20 }));

    const boosts = board.shortlist
      .flatMap((s) => s.explanation.adjustments)
      .filter((a) => a.rule === "preferred");
    expect(boosts.length).toBeGreaterThan(0);
    for (const b of boosts) {
      expect(b.magnitude).toBeLessThanOrEqual(PREFERRED_CAP * board.roundValue + 0.01);
      expect(b.magnitude).toBeGreaterThan(0);
    }
  });

  it("does NOT lift a materially worse player to the top", () => {
    // The whole point of a bound. Prefer the WORST available player and require
    // that they still do not lead the board.
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 0 });
    const plain = recommend(bundle, state);
    const worst = plain.entries.filter((e) => e.finalValue > Number.NEGATIVE_INFINITY).at(-1)!;

    bundle.preferred = new Set([worst.playerId]);
    const boosted = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    expect(boosted.entries[0]!.playerId).not.toBe(worst.playerId);
  });

  it("CAN lift a player over one worth slightly less than a round more", () => {
    // The bound must not be so tight the rule never fires — that would satisfy
    // SC-006 while making US3 pointless.
    const bundle = makeBundle();
    const plain = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    // Someone just behind the leader, within a round's worth of value.
    const target = plain.entries.find(
      (e) => e.rank > 1 && plain.entries[0]!.finalValue - e.finalValue < plain.roundValue * PREFERRED_CAP,
    );
    expect(target, "fixture must contain a player within one round of the leader").toBeDefined();

    bundle.preferred = new Set([target!.playerId]);
    const boosted = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const after = boosted.entries.find((e) => e.playerId === target!.playerId)!;
    expect(after.rank).toBeLessThan(target!.rank);
  });

  it("an EMPTY list produces exactly the value-and-rules ranking (US3 AS4)", () => {
    const bundle = makeBundle();
    const a = recommend(bundle, makeState(bundle, { picksMade: 14 }));
    bundle.preferred = new Set();
    const b = recommend(bundle, makeState(bundle, { picksMade: 14 }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.shortlist.flatMap((s) => s.explanation.adjustments).filter((x) => x.rule === "preferred")).toEqual(
      [],
    );
  });
});

describe("the boost is distinctly identified (FR-026)", () => {
  it("carries the exact value it contributed, as its own field", () => {
    const bundle = makeBundle();
    const first = recommend(bundle, makeState(bundle, { picksMade: 0 })).entries[0]!;
    bundle.preferred = new Set([first.playerId]);
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const entry = board.shortlist.find((s) => s.playerId === first.playerId)!;

    const boost = entry.explanation.adjustments.find((a) => a.rule === "preferred")!;
    expect(boost).toBeDefined();
    expect(boost.magnitude).toBeGreaterThan(0);
    expect(boost.direction).toBe("up");
    expect(boost.reason).toBe("on your preferred list");
    // Exactly the difference the preference made — readable without recomputing.
    expect(entry.finalValue - first.finalValue).toBeCloseTo(boost.magnitude, 2);
  });

  it("flags the player on the ENTRY too, so a display can badge below the head", () => {
    // FR-026: a display must not have to fetch an explanation to know a player
    // ranked 40th is on the owner's list.
    const bundle = makeBundle();
    const plain = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const deep = plain.entries[60]!;
    bundle.preferred = new Set([deep.playerId]);
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const found = board.entries.find((e) => e.playerId === deep.playerId)!;
    expect(found.preferred).toBe(true);
    expect(board.entries.filter((e) => e.preferred)).toHaveLength(1);
  });

  it("marks nobody preferred when the list is empty", () => {
    const bundle = makeBundle();
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    expect(board.entries.some((e) => e.preferred)).toBe(false);
  });
});

describe("the unit (FR-007, Constitution II and III)", () => {
  it("scales with the league rather than being a flat point count", () => {
    const small = preferredAdjustment(true, 8);
    const large = preferredAdjustment(true, 40);
    expect(large!.magnitude).toBeGreaterThan(small!.magnitude * 4);
  });

  it("is silent when there is no list entry", () => {
    expect(preferredAdjustment(false, 10)).toBeNull();
  });

  it("is silent when a round is worth nothing — the end of the draft", () => {
    expect(preferredAdjustment(true, 0)).toBeNull();
  });
});

describe("FR-021 — a preferred player who is not on the board", () => {
  it("is inert: the ranking is unaffected rather than crashing", () => {
    const bundle = makeBundle();
    const before = recommend(bundle, makeState(bundle, { picksMade: 8 }));
    // Ids that exist nowhere, including a negative one.
    bundle.preferred = new Set([424242, -999999]);
    const after = recommend(bundle, makeState(bundle, { picksMade: 8 }));
    expect(JSON.stringify(after.entries)).toBe(JSON.stringify(before.entries));
  });

  it("is inert even when a DRAFTED player is on the list", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 8 });
    const taken = [...state.drafted][0]!;
    bundle.preferred = new Set([taken]);
    const board = recommend(bundle, state);
    expect(board.entries.some((e) => e.playerId === taken)).toBe(false);
  });
});
