// 006 T033/T034/T035 — explanations, and the invariant that makes them honest.
//
// The first test does something unusual and deliberate: it CONSTRUCTS AN
// EXPLANATION THAT DOES NOT RECONCILE and requires the checker to reject it.
//
// That is not belt-and-braces. During 005 two tests survived their own
// mutations — they passed against correct code and against deliberately broken
// code alike, and nobody noticed until the code was broken on purpose. A test
// for an invariant that has never been shown to fail is a test that might be
// asserting nothing at all.

import { describe, expect, it } from "vitest";
import { explain, finalValueOf, reconciles, RECONCILE_EPSILON } from "../../src/engine/explain";
import { recommend } from "../../src/engine/recommend";
import { makeBundle, makeState } from "./helpers";
import type { Adjustment } from "../../src/engine/types";

const adj = (rule: Adjustment["rule"], magnitude: number): Adjustment => ({
  rule,
  magnitude,
  direction: magnitude >= 0 ? "up" : "down",
  reason: `${rule} fired`,
});

describe("the reconciliation invariant (FR-027, SC-014)", () => {
  it("holds for an explanation built the normal way", () => {
    const e = explain({
      rawValue: 40,
      roundValue: 10,
      adjustments: [adj("offense", 2.5), adj("bye", -1.5), adj("preferred", 3)],
      missing: [],
      forcedBy: null,
    });
    expect(e.finalValue).toBeCloseTo(44, 5);
    expect(reconciles(e)).toBe(true);
  });

  it("REJECTS an explanation whose parts do not add up", () => {
    // The test that proves the checker can fail. A hand-built explanation with
    // a finalValue that no combination of its adjustments produces — exactly
    // what "something moved the ranking the owner was never told about" looks
    // like in data.
    const e = explain({
      rawValue: 40,
      roundValue: 10,
      adjustments: [adj("offense", 2.5)],
      missing: [],
      forcedBy: null,
    });
    const tampered = { ...e, finalValue: e.finalValue + 5 };
    expect(reconciles(tampered)).toBe(false);
  });

  it("rejects a HIDDEN adjustment — the realistic form of the bug", () => {
    // Not a mangled total, but a rule that fired and was left out of the list.
    const honest = explain({
      rawValue: 40,
      roundValue: 10,
      adjustments: [adj("offense", 2.5), adj("survival", 3)],
      missing: [],
      forcedBy: null,
    });
    const hidden = { ...honest, adjustments: honest.adjustments.filter((a) => a.rule !== "survival") };
    expect(reconciles(hidden)).toBe(false);
  });

  it("tolerates float noise within the stated epsilon, and nothing more", () => {
    const e = explain({ rawValue: 1 / 3, roundValue: 10, adjustments: [adj("sos", 1 / 7)], missing: [], forcedBy: null });
    expect(reconciles(e)).toBe(true);
    expect(reconciles({ ...e, finalValue: e.finalValue + RECONCILE_EPSILON * 3 })).toBe(false);
  });

  it("derives finalValue from the adjustments — one source, so it cannot drift", () => {
    const adjustments = [adj("offense", 1.25), adj("scarcity", -0.75)];
    expect(finalValueOf(10, adjustments)).toBeCloseTo(10.5, 5);
    expect(finalValueOf(10, [])).toBe(10);
  });
});

describe("an explanation with nothing to say", () => {
  it("says so plainly rather than omitting the section (US2 AS3)", () => {
    const e = explain({ rawValue: 20, roundValue: 10, adjustments: [], missing: [], forcedBy: null });
    // Present and empty, never absent. A consumer must be able to distinguish
    // "no rule fired" from "we forgot to tell you".
    expect(Array.isArray(e.adjustments)).toBe(true);
    expect(e.adjustments).toEqual([]);
    expect(e.finalValue).toBe(e.rawValue);
    expect(reconciles(e)).toBe(true);
  });

  it("keeps `missing` and `alternatives` as arrays too", () => {
    const e = explain({ rawValue: 20, roundValue: 10, adjustments: [], missing: [], forcedBy: null });
    expect(e.missing).toEqual([]);
    expect(e.alternatives).toEqual([]);
    expect(e.forcedBy).toBeNull();
  });
});

describe("missing inputs are named (FR-013)", () => {
  it("names each unavailable input rather than a generic flag", () => {
    const e = explain({
      rawValue: 20,
      roundValue: 10,
      adjustments: [],
      missing: [
        { input: "oline", detail: "no offensive line rating for SF" },
        { input: "adp", detail: "average draft position is at ESPN's floor, so it says nothing" },
      ],
      forcedBy: null,
    });
    expect(e.missing.map((m) => m.input)).toEqual(["adp", "oline"]); // sorted, deterministic
    expect(e.missing[1]!.detail).toMatch(/offensive line/);
  });
});

describe("ordering is deterministic (SC-003)", () => {
  it("sorts adjustments by rule name, so two runs serialise identically", () => {
    const a = explain({
      rawValue: 20,
      roundValue: 10,
      adjustments: [adj("survival", 1), adj("bye", -1), adj("offense", 2)],
      missing: [],
      forcedBy: null,
    });
    expect(a.adjustments.map((x) => x.rule)).toEqual(["bye", "offense", "survival"]);
  });
});

describe("naming, and sensitivity to the inputs (FR-024, US2's Independent Test)", () => {
  it("names the SURVIVAL reason in words when it moved a player", () => {
    // FR-024: "unlikely to last to your next turn" is a reason an owner can
    // weigh; a shifted number is not.
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 24, myTeamId: 3 });
    const board = recommend(bundle, state);
    const withSurvival = board.shortlist
      .flatMap((s) => s.explanation.adjustments)
      .filter((a) => a.rule === "survival");
    expect(withSurvival.length).toBeGreaterThan(0);
    for (const a of withSurvival) {
      expect(a.reason).toMatch(/last your next \d+ picks/);
      expect(a.reason).not.toMatch(/^-?\d+(\.\d+)?$/); // not a bare number
    }
  });

  it("REMOVING A SIGNAL CHANGES THE EXPLANATION", () => {
    // This is what separates a real explanation from a template that always
    // says the same thing. Without it, an engine that emitted a fixed list of
    // plausible reasons would pass every other test in this file.
    const withAll = makeBundle();
    const state = makeState(withAll, { picksMade: 18 });

    const withoutOline = makeBundle();
    withoutOline.players = withAll.players;
    withoutOline.proTeamByPlayer = withAll.proTeamByPlayer;
    withoutOline.signals = new Map(withAll.signals);
    withoutOline.signals.delete("oline");

    const a = recommend(withAll, state);
    const b = recommend(withoutOline, makeState(withoutOline, { picksMade: 18 }));

    const rulesOf = (board: typeof a): string[] =>
      board.shortlist.flatMap((s) => s.explanation.adjustments.map((x) => x.rule));
    expect(rulesOf(a)).toContain("oline");
    expect(rulesOf(b)).not.toContain("oline");

    // And the absence is REPORTED, not silently dropped (FR-013).
    const missing = b.shortlist.flatMap((s) => s.explanation.missing.map((m) => m.input));
    expect(missing).toContain("oline");
  });

  it("changes the explanation when the owner's roster changes", () => {
    // The bye rule reads `myRoster`, so a different roster must produce a
    // different explanation for the same player at the same pick.
    const bundle = makeBundle();
    const plain = makeState(bundle, { picksMade: 12, myTeamId: 1 });
    const target = recommend(bundle, plain).shortlist[0]!;

    const clashing = {
      ...plain,
      myRoster: [
        {
          playerId: -1,
          position: target.position,
          byeWeek: bundle.players.find((p) => p.espn_player_id === target.playerId)!.bye_week,
        },
      ],
    };
    const after = recommend(bundle, clashing);
    const moved = after.entries.find((e) => e.playerId === target.playerId)!;
    expect(moved.finalValue).toBeLessThan(target.finalValue);
  });
});

describe("alternatives (FR-009)", () => {
  it("names the next-best players actually considered", () => {
    const bundle = makeBundle();
    const board = recommend(bundle, makeState(bundle, { picksMade: 10 }));
    const head = board.shortlist[0]!;
    expect(head.explanation.alternatives.length).toBeGreaterThan(0);
    // They are the players immediately behind, taken from the real ordering
    // rather than recomputed — so what the owner is shown is what was weighed.
    expect(head.explanation.alternatives[0]!.playerId).toBe(board.entries[1]!.playerId);
    expect(head.explanation.alternatives.every((a) => a.finalValue <= head.finalValue)).toBe(true);
  });

  it("does not run off the end near the bottom of the board", () => {
    const two = makeBundle().players.slice(0, 2);
    const bundle = makeBundle({ players: two });
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    expect(board.shortlist).toHaveLength(2);
    expect(board.shortlist[1]!.explanation.alternatives).toEqual([]);
  });
});
