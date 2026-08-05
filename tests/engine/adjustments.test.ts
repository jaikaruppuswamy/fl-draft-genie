// 006 T021/T022 — the five rule adjustments.
//
// T021 covers research §5a's three team signals; T022 covers §5b (bye clash)
// and §5c (positional run), which have no signal row and no 0–100 score.
//
// The distinction the tests exist to protect is "NOT APPLICABLE" versus
// "MISSING". O-line does not move a kicker — nothing to report. O-line data
// being absent for a player it WOULD move is a gap the owner should be told
// about (FR-013). A single code path collapses these into one silent zero.

import { describe, expect, it } from "vitest";
import { expectedShares, ruleAdjustments } from "../../src/engine/adjustments";
import { WEIGHT } from "../../src/engine/constants";
import type { SignalKind, SignalValue } from "../../src/engine/types";
import type { BoardEntry } from "../../src/projections/scoring";

const ROUND = 10;
const TEAM_ID = 7;

function sig(score: number, rank: number): SignalValue {
  return { raw_value: score, score, rank, provenance: "test", computed_at: "2026-08-01T00:00:00.000Z" };
}

function signals(over: Partial<Record<SignalKind, number>> = {}): Map<SignalKind, Map<number, SignalValue>> {
  const m = new Map<SignalKind, Map<number, SignalValue>>();
  for (const kind of ["offense", "sos", "oline"] as SignalKind[]) {
    const score = over[kind] ?? 50;
    const rank = score >= 90 ? 2 : score <= 10 ? 31 : 16;
    m.set(kind, new Map([[TEAM_ID, sig(score, rank)]]));
  }
  return m;
}

function player(position: string, bye: number | null = 9): BoardEntry {
  return {
    espn_player_id: 1,
    name: "Test Player",
    position,
    eligible_positions: [position],
    team: "SF",
    bye_week: bye,
    projected_points: 100,
    position_rank: 1,
    adp: 20,
    overall_rank: 1,
  };
}

const STARTERS = new Map([
  ["QB", 1],
  ["RB", 2],
  ["WR", 2],
  ["TE", 1],
  ["K", 1],
  ["DST", 1],
]);
const SHARES = new Map([
  ["QB", 0.1],
  ["RB", 0.25],
  ["WR", 0.25],
  ["TE", 0.15],
  ["K", 0.1],
  ["DST", 0.15],
]);

function run(over: Partial<Parameters<typeof ruleAdjustments>[0]> = {}) {
  return ruleAdjustments({
    player: player("RB"),
    proTeamId: TEAM_ID,
    signals: signals(),
    myRoster: [],
    startersPerTeam: STARTERS,
    expectedShare: SHARES,
    recentPositions: [],
    teamCount: 12,
    roundValue: ROUND,
    ...over,
  });
}

const by = (r: ReturnType<typeof run>, rule: string) => r.adjustments.find((a) => a.rule === rule);

describe("§5a — the three team signals", () => {
  it("moves a player up for a strong signal and down for a weak one", () => {
    const good = by(run({ signals: signals({ offense: 100 }) }), "offense")!;
    const bad = by(run({ signals: signals({ offense: 0 }) }), "offense")!;
    expect(good.magnitude).toBeGreaterThan(0);
    expect(good.direction).toBe("up");
    expect(bad.magnitude).toBeLessThan(0);
    expect(bad.direction).toBe("down");
  });

  it("caps a signal's contribution at its weight", () => {
    const max = by(run({ signals: signals({ offense: 100 }) }), "offense")!;
    expect(Math.abs(max.magnitude)).toBeLessThanOrEqual(WEIGHT.offense * ROUND + 1e-6);
  });

  it("names the reason in words, not as a score (Constitution VII)", () => {
    const a = by(run({ signals: signals({ offense: 100 }) }), "offense")!;
    expect(a.reason).toBe("top-5 offense");
    expect(a.reason).not.toMatch(/\d\d\.\d/);
  });

  it("honours the relevance matrix — O-line moves an RB", () => {
    expect(by(run({ player: player("RB"), signals: signals({ oline: 100 }) }), "oline")).toBeDefined();
  });

  it("honours the relevance matrix — O-line NEVER moves a WR, TE, K or DST", () => {
    for (const position of ["WR", "TE", "K", "DST"]) {
      const r = run({ player: player(position), signals: signals({ oline: 100 }) });
      expect(by(r, "oline"), `oline must not move ${position}`).toBeUndefined();
      // And it is not reported missing either — the question does not arise.
      expect(r.missing.map((m) => m.input)).not.toContain("oline");
    }
  });

  it("does not apply offense to a defence", () => {
    const r = run({ player: player("DST"), signals: signals({ offense: 100 }) });
    expect(by(r, "offense")).toBeUndefined();
    expect(r.missing.map((m) => m.input)).not.toContain("offense");
  });

  it("reports a signal that SHOULD apply but is unavailable (FR-013)", () => {
    // The other half of the distinction: this one the owner is entitled to know.
    const noOline = signals();
    noOline.delete("oline");
    const r = run({ player: player("RB"), signals: noOline });
    expect(by(r, "oline")).toBeUndefined();
    expect(r.missing.find((m) => m.input === "oline")).toBeDefined();
  });

  it("reports a missing rating for one team while others have one", () => {
    const r = run({ proTeamId: 999 });
    expect(r.missing.map((m) => m.input).sort()).toEqual(["offense", "oline", "sos"]);
  });

  it("reports missing rather than crashing when the player has no pro team", () => {
    const r = run({ proTeamId: undefined });
    expect(r.adjustments.filter((a) => a.rule === "offense")).toEqual([]);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it("emits NOTHING for a dead-centre signal rather than a zero adjustment", () => {
    // A zero magnitude in the list would claim a rule fired and moved nothing.
    const r = run({ signals: signals({ offense: 50, sos: 50, oline: 50 }) });
    expect(r.adjustments.filter((a) => ["offense", "sos", "oline"].includes(a.rule))).toEqual([]);
  });
});

describe("§5b — bye-week clash", () => {
  it("penalises a clash with a player already on the roster", () => {
    const r = run({
      player: player("RB", 9),
      myRoster: [{ playerId: 2, position: "RB", byeWeek: 9 }],
    });
    expect(by(r, "bye")!.magnitude).toBeLessThan(0);
    expect(by(r, "bye")!.reason).toMatch(/bye week 9 clashes with your RB/);
  });

  it("ignores a clash at a DIFFERENT position", () => {
    const r = run({
      player: player("RB", 9),
      myRoster: [{ playerId: 2, position: "WR", byeWeek: 9 }],
    });
    expect(by(r, "bye")).toBeUndefined();
  });

  it("ignores a different bye at the same position", () => {
    const r = run({
      player: player("RB", 9),
      myRoster: [{ playerId: 2, position: "RB", byeWeek: 5 }],
    });
    expect(by(r, "bye")).toBeUndefined();
  });

  it("weighs a clash against a position with FEW starters more heavily", () => {
    // One clashing TE (1 starter) is your whole tight end slot. One clashing
    // RB (2 starters) is half your backfield. The severity must reflect that,
    // or the rule is a flat penalty wearing a proportional costume.
    const te = by(
      run({
        player: player("TE", 9),
        myRoster: [{ playerId: 2, position: "TE", byeWeek: 9 }],
      }),
      "bye",
    )!;
    const rb = by(
      run({
        player: player("RB", 9),
        myRoster: [{ playerId: 2, position: "RB", byeWeek: 9 }],
      }),
      "bye",
    )!;
    expect(Math.abs(te.magnitude)).toBeGreaterThan(Math.abs(rb.magnitude));
  });

  it("scales with the NUMBER of clashing players, and saturates", () => {
    const one = by(
      run({ player: player("RB", 9), myRoster: [{ playerId: 2, position: "RB", byeWeek: 9 }] }),
      "bye",
    )!;
    const two = by(
      run({
        player: player("RB", 9),
        myRoster: [
          { playerId: 2, position: "RB", byeWeek: 9 },
          { playerId: 3, position: "RB", byeWeek: 9 },
        ],
      }),
      "bye",
    )!;
    expect(Math.abs(two.magnitude)).toBeGreaterThan(Math.abs(one.magnitude));
    const four = by(
      run({
        player: player("RB", 9),
        myRoster: Array.from({ length: 4 }, (_, k) => ({ playerId: 10 + k, position: "RB", byeWeek: 9 })),
      }),
      "bye",
    )!;
    expect(Math.abs(four.magnitude)).toBeLessThanOrEqual(WEIGHT.bye * ROUND + 1e-6);
  });

  it("reports an unknown bye as missing rather than assuming no clash", () => {
    const r = run({ player: player("RB", null) });
    expect(r.missing.find((m) => m.input === "bye")).toBeDefined();
  });
});

describe("§5c — the positional run", () => {
  it("rewards a position going faster than its share of starter slots", () => {
    // RB expected share 0.25; here 8 of the last 12 picks were RBs.
    const recent = [...Array(8).fill("RB"), ...Array(4).fill("WR")];
    const a = by(run({ recentPositions: recent }), "scarcity")!;
    expect(a.magnitude).toBeGreaterThan(0);
    expect(a.reason).toMatch(/a run on RB/);
  });

  it("penalises a position going SLOWER than its share", () => {
    const recent = Array(12).fill("WR");
    const a = by(run({ recentPositions: recent }), "scarcity")!;
    expect(a.magnitude).toBeLessThan(0);
    expect(a.reason).toMatch(/going slower than usual/);
  });

  it("emits NOTHING when no picks have been made", () => {
    // An absence of evidence, not a missing input — nothing has happened yet.
    const r = run({ recentPositions: [] });
    expect(by(r, "scarcity")).toBeUndefined();
    expect(r.missing.map((m) => m.input)).not.toContain("scarcity");
  });

  it("looks back exactly teamCount picks, not the whole draft", () => {
    // A run in round 1 must not still be firing in round 9. The window is what
    // makes this a "run" rather than a census.
    const ancient = [...Array(12).fill("RB"), ...Array(12).fill("WR")];
    const a = by(run({ recentPositions: ancient, teamCount: 12 }), "scarcity")!;
    expect(a.magnitude).toBeLessThan(0); // only the WR dozen is in view
  });

  it("uses a shorter window when fewer picks exist", () => {
    const r = run({ recentPositions: ["RB", "RB"], teamCount: 12 });
    expect(by(r, "scarcity")!.reason).toMatch(/last 2 picks/);
  });

  it("caps intensity at its weight in both directions", () => {
    const hot = by(run({ recentPositions: Array(12).fill("RB") }), "scarcity")!;
    const cold = by(run({ recentPositions: Array(12).fill("QB") }), "scarcity")!;
    expect(Math.abs(hot.magnitude)).toBeLessThanOrEqual(WEIGHT.scarcity * ROUND + 1e-6);
    expect(Math.abs(cold.magnitude)).toBeLessThanOrEqual(WEIGHT.scarcity * ROUND + 1e-6);
  });
});

describe("degenerate inputs", () => {
  it("produces nothing when ROUND_VALUE has collapsed", () => {
    expect(run({ roundValue: 0 }).adjustments).toEqual([]);
  });

  it("never emits a NaN", () => {
    const r = run({ recentPositions: ["RB"], expectedShare: new Map([["RB", 0]]) });
    expect(r.adjustments.every((a) => Number.isFinite(a.magnitude))).toBe(true);
  });
});

describe("expectedShares", () => {
  it("turns boundary counts into shares that sum to 1", () => {
    const shares = expectedShares(
      new Map([
        ["RB", 30],
        ["WR", 30],
        ["QB", 12],
        ["TE", 12],
        ["K", 12],
        ["DST", 12],
      ]),
    );
    const total = [...shares.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(shares.get("RB")).toBeCloseTo(30 / 108, 9);
  });

  it("returns an empty map rather than dividing by zero", () => {
    expect(expectedShares(new Map()).size).toBe(0);
    expect(expectedShares(new Map([["RB", 0]])).size).toBe(0);
  });
});
