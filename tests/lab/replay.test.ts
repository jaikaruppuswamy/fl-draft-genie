// 008 T015/T019/T021 — the shadow replay, written before the implementation.
//
// These assertions are the ones that decide whether a scorecard means anything.
// A replay that puts the engine on the wrong pick, or lets the engine's own
// preference change the sequence, produces confident numbers about a draft that
// never happened.

import { describe, expect, it } from "vitest";
import { NotReplayableError, decisiveRule, fidelityFor, replayEntry } from "../../src/lab/replay";
import { canonicalHash } from "../../src/lab/codec";
import type { Recommendation } from "../../src/engine/types";
import { bundle, entry, pick } from "./helpers";

/** 6 teams, order 1..6, owner is team 1 ⇒ turns at overall 1 and 12 (snake). */
const OWNER_TURNS = [1, 12];

describe("replayEntry", () => {
  it("observes exactly the owner's turns, derived from round and order", () => {
    // Snake: round 1 runs 1..6, round 2 runs 6..1, so team 1 picks at 1 and 12.
    // Derived from the ROUND — never from a field on the pick, the reading
    // 010's oracle disproved at 5 of 70.
    const result = replayEntry(entry(), bundle());
    expect(result.turns.map((t) => t.overall)).toEqual(OWNER_TURNS);
  });

  it("puts the engine on the clock for the turn — not before it, not after", () => {
    // `deriveState` computes frontier = picks.length + 1, so the turn at
    // overall 12 must see exactly 11 prior picks. Off by one here and every
    // recommendation is for the wrong moment.
    const result = replayEntry(entry(), bundle());
    const second = result.turns.find((t) => t.overall === 12)!;
    // Players 1001..1011 are gone by then; 1012 is the pick being made.
    expect(second.shortlist.every((s) => s.playerId !== 1001)).toBe(true);
  });

  it("carries the engine's warnings through on every turn", () => {
    const result = replayEntry(entry(), bundle());
    for (const t of result.turns) expect(Array.isArray(t.warnings)).toBe(true);
  });

  it("reports where the actually-drafted player ranked", () => {
    const result = replayEntry(entry(), bundle());
    const first = result.turns[0]!;
    expect(first.actualPlayerId).toBe(1001);
    expect(first.actual).not.toBeNull();
    expect(first.actual!.rank).toBeGreaterThan(0);
  });

  it("states an off-board pick rather than failing the turn", () => {
    // A drafted player absent from the board is NORMAL — obscure, released, or
    // outside the serving set. FR-005: say so, and still produce a result.
    const picks = Array.from({ length: 12 }, (_, i) =>
      pick({ overall: i + 1, playerId: i === 0 ? 999_999 : 1000 + i + 1 }),
    );
    const result = replayEntry(entry({ picks }), bundle());
    const first = result.turns[0]!;
    expect(first.actualPlayerId).toBe(999_999);
    expect(first.actual).toBeNull();
    expect(first.gapToHead).toBeNull();
    expect(first.engineHead).not.toBeNull();
  });

  it("handles a negative D/ST id as a real player", () => {
    const picks = Array.from({ length: 12 }, (_, i) =>
      pick({ overall: i + 1, playerId: i === 0 ? -16001 : 1000 + i + 1 }),
    );
    const result = replayEntry(entry({ picks }), bundle());
    expect(result.turns[0]!.actualPlayerId).toBe(-16001);
    expect(result.turns[0]!.actual).not.toBeNull();
  });

  it("reports the gap in ROUNDS, the unit comparable across leagues", () => {
    const result = replayEntry(entry(), bundle());
    const withGap = result.turns.find((t) => t.gapToHead !== null);
    expect(withGap).toBeDefined();
    expect(withGap!.roundValue).toBeGreaterThan(0);
    expect(withGap!.gapInRounds).toBeCloseTo(withGap!.gapToHead! / withGap!.roundValue, 3);
  });

  it("treats keepers as unavailable from pick one, on every team", () => {
    const withKeeper = entry({ keepers: [{ teamId: 4, playerId: 1002 }] });
    const result = replayEntry(withKeeper, bundle());
    // 1002 is held by ANOTHER team and must never be recommended.
    expect(result.turns[0]!.shortlist.every((s) => s.playerId !== 1002)).toBe(true);
  });
});

describe("the shadow property (FR-007)", () => {
  it("applies the entry's own picks, unchanged", () => {
    // The engine's preference must never alter the sequence. Once simulate.ts
    // sits beside replay.ts, this is exactly the distinction that blurs — and a
    // replay that quietly took the engine's pick would be reporting on a draft
    // that never happened.
    const e = entry();
    const result = replayEntry(e, bundle());
    expect(result.appliedPicks).toEqual(e.picks.map((p) => p.overall));
  });

  it("gives the same turns regardless of what the engine prefers", () => {
    // Same draft, two very different boards: the observed turns and the picks
    // applied are identical, because neither depends on the engine at all.
    const e = entry();
    const a = replayEntry(e, bundle());
    const b = replayEntry(e, bundle({ preferred: new Set([1005, 1006, 1007]) }));
    expect(a.appliedPicks).toEqual(b.appliedPicks);
    expect(a.turns.map((t) => t.overall)).toEqual(b.turns.map((t) => t.overall));
    expect(a.turns.map((t) => t.actualPlayerId)).toEqual(b.turns.map((t) => t.actualPlayerId));
  });
});

describe("refusals", () => {
  it("refuses a pick_sequence_only entry structurally", () => {
    // FR-020b. Running the engine over a 2024 pick sequence against a 2026
    // board produces numbers that look like evidence and are not.
    const e = entry({
      useClass: "pick_sequence_only",
      unreplayableReason: "no projection set exists for 2024",
    });
    expect(() => replayEntry(e, bundle())).toThrow(NotReplayableError);
    expect(() => replayEntry(e, bundle())).toThrow(/no projection set exists for 2024/);
  });

  it("refuses an entry with no owner team", () => {
    expect(() => replayEntry(entry({ myTeamId: null }), bundle())).toThrow(/no owner team/);
  });

  it("refuses an entry with no pick order rather than guessing one", () => {
    expect(() => replayEntry(entry({ order: [] }), bundle())).toThrow(/pick order unknown/);
  });
});

describe("determinism (SC-002)", () => {
  it("produces an identical hash across runs", () => {
    const e = entry();
    expect(canonicalHash(replayEntry(e, bundle()), { round: 4 })).toBe(
      canonicalHash(replayEntry(e, bundle()), { round: 4 }),
    );
  });

  it("PROVES the check can fail", () => {
    // The companion assertion. Comparing a run to itself passes against any
    // implementation — 007 shipped an SC-003 assertion that pushed a hardcoded
    // 0 and asserted it was under 2000, and it would have passed against
    // nothing at all. This shows a real difference is detected.
    const a = replayEntry(entry(), bundle());
    const perturbed = replayEntry(entry(), bundle({ preferred: new Set([1007]) }));
    expect(canonicalHash(a, { round: 4 })).not.toBe(canonicalHash(perturbed, { round: 4 }));
  });

  it("does not depend on the order picks arrive in", () => {
    const e = entry();
    const shuffled = entry({ picks: [...e.picks].reverse() });
    expect(canonicalHash(replayEntry(e, bundle()), { round: 4 })).toBe(
      canonicalHash(replayEntry(shuffled, bundle()), { round: 4 }),
    );
  });
});

describe("decisiveRule", () => {
  const rec = (playerId: number, rule: string, magnitude: number): Recommendation =>
    ({
      playerId,
      name: `P${playerId}`,
      position: "RB",
      team: "SF",
      rank: 1,
      rawValue: 10,
      finalValue: 12,
      preferred: false,
      explanation: {
        rawValue: 10,
        finalValue: 12,
        roundValue: 20,
        adjustments: [{ rule, magnitude, direction: "up", reason: "because" }],
        missing: [],
        alternatives: [],
        forcedBy: null,
      },
    }) as unknown as Recommendation;

  it("is null when the rules did not change who came first", () => {
    const entries = [
      { playerId: 1, rawValue: 100, finalValue: 105 },
      { playerId: 2, rawValue: 90, finalValue: 95 },
    ];
    expect(decisiveRule(entries, [rec(1, "bye", -2)])).toBeNull();
  });

  it("names the largest adjustment on the player the rules promoted", () => {
    // Player 2 trails on raw value and leads on final value: the rules were
    // decisive, and `preferred` moved him further than `bye` did.
    const entries = [
      { playerId: 2, rawValue: 90, finalValue: 120 },
      { playerId: 1, rawValue: 100, finalValue: 105 },
    ];
    const shortlist = [
      {
        ...rec(2, "preferred", 25),
        explanation: {
          ...rec(2, "preferred", 25).explanation,
          adjustments: [
            { rule: "bye", magnitude: -5, direction: "down", reason: "clash" },
            { rule: "preferred", magnitude: 25, direction: "up", reason: "on your list" },
          ],
        },
      } as unknown as Recommendation,
    ];
    expect(decisiveRule(entries, shortlist)).toBe("preferred");
  });

  it("weighs magnitude by size, not by sign", () => {
    const entries = [
      { playerId: 2, rawValue: 90, finalValue: 120 },
      { playerId: 1, rawValue: 100, finalValue: 105 },
    ];
    const shortlist = [
      {
        ...rec(2, "bye", -30),
        explanation: {
          ...rec(2, "bye", -30).explanation,
          adjustments: [
            { rule: "bye", magnitude: -30, direction: "down", reason: "clash" },
            { rule: "offense", magnitude: 5, direction: "up", reason: "top-5" },
          ],
        },
      } as unknown as Recommendation,
    ];
    expect(decisiveRule(entries, shortlist)).toBe("bye");
  });

  it("is null on an empty board", () => {
    expect(decisiveRule([], [])).toBeNull();
  });
});

describe("fidelityFor", () => {
  it("marks signals present_day for a draft admitted after the fact", () => {
    // Permanent for that entry: signal_entries is overwritten in place and has
    // no history, so a retro-admitted draft can never recover its own.
    const f = fidelityFor(entry(), false);
    expect(f.board).toBe("as_of");
    expect(f.signals).toBe("present_day");
    expect(f.notes.join(" ")).toMatch(/overwritten in place|no history/);
  });

  it("marks signals as_of when the snapshot was taken during the draft", () => {
    expect(fidelityFor(entry(), true).signals).toBe("as_of");
  });

  it("notes a test run in the fidelity, so it cannot be read as evidence", () => {
    expect(fidelityFor(entry({ provenanceClass: "test" }), true).notes.join(" ")).toMatch(/test run/);
  });
});
