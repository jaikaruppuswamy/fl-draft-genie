// 008 T032/T035 — the scorecard, and what it refuses to claim.

import { describe, expect, it } from "vitest";
import { buildScorecard, flattenConstants } from "../../src/lab/scorecard";
import { fidelityFor, replayEntry } from "../../src/lab/replay";
import type { CorpusEntry } from "../../src/lab/corpus";
import { bundle, entry } from "./helpers";

function considered(entries: CorpusEntry[]) {
  return entries.map((e) => ({
    entry: e,
    fidelity: fidelityFor(e, false),
    turns: e.useClass === "replayable" ? replayEntry(e, bundle()).turns : null,
  }));
}

const build = (entries: CorpusEntry[]) =>
  buildScorecard({ considered: considered(entries), engineVersion: "engine-abc123" });

describe("admissibility is enforced at the scorecard, not left to the caller", () => {
  it("includes an entry that is replayable and real", () => {
    const card = build([entry()]);
    expect(card.entries.map((e) => e.entryId)).toEqual(["test-2026"]);
    expect(card.excluded).toEqual([]);
    expect(card.behavioural.turnCount).toBeGreaterThan(0);
  });

  it("EXCLUDES a test run, and names why", () => {
    // The trap: a mock draft replays perfectly. Nothing downstream could detect
    // its influence, so the refusal has to happen here.
    const card = build([entry({ id: "mock", provenanceClass: "test" })]);
    expect(card.entries).toEqual([]);
    expect(card.excluded).toHaveLength(1);
    expect(card.excluded[0]!.reason).toContain("test run");
    expect(card.behavioural.turnCount).toBe(0);
  });

  it("excludes a pick_sequence_only entry, and names why", () => {
    const card = build([
      entry({ id: "old", useClass: "pick_sequence_only", unreplayableReason: "no 2024 board" }),
    ]);
    expect(card.entries).toEqual([]);
    expect(card.excluded[0]!.reason).toContain("no 2024 board");
  });

  it("never drops an entry silently", () => {
    const card = build([
      entry({ id: "good" }),
      entry({ id: "mock", provenanceClass: "test" }),
      entry({ id: "old", useClass: "pick_sequence_only", unreplayableReason: "no board" }),
    ]);
    expect(card.entries.length + card.excluded.length).toBe(3);
    for (const x of card.excluded) expect(x.reason).toBeTruthy();
  });
});

describe("the outcome slot stays empty (FR-017a)", () => {
  it("is null, not zero and not omitted", () => {
    // The 2026 season has not been played. Filling this with anything
    // projection-derived would reward agreement with the engine's own input,
    // which is exactly what the rule layer exists to correct.
    const card = build([entry()]);
    expect(card.outcome).toBeNull();
    expect("outcome" in card).toBe(true);
  });

  it("reports no aggregate that scores roster quality", () => {
    // Guard against a future "helpful" addition. Every key here must be
    // descriptive: what the engine did, never whether it was right.
    const card = build([entry()]);
    const keys = Object.keys(card.behavioural);
    for (const banned of ["rosterStrength", "projectedPoints", "quality", "score"]) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe("behavioural measures", () => {
  it("counts turns and reports head agreement as a rate", () => {
    const card = build([entry()]);
    expect(card.behavioural.turnCount).toBe(2);
    expect(card.behavioural.headAgreementRate).toBeGreaterThanOrEqual(0);
    expect(card.behavioural.headAgreementRate).toBeLessThanOrEqual(1);
  });

  it("buckets the drafted player's rank in a FIXED order", () => {
    // A diff should show the same rows in the same places whatever the numbers
    // did; sorting by count would reshuffle the report on every run.
    const card = build([entry()]);
    expect(card.behavioural.actualRankDistribution.map((b) => b.bucket)).toEqual([
      "1",
      "2-3",
      "4-5",
      "6-10",
      "11-25",
      "26+",
      "off-board",
    ]);
  });

  it("counts off-board picks separately from a bad rank", () => {
    // "Not on the board" and "ranked 400th" are different facts; averaging them
    // together would hide both.
    const picks = entry().picks.map((p, i) => (i === 0 ? { ...p, playerId: 999_999 } : p));
    const card = build([entry({ picks })]);
    expect(card.behavioural.offBoardPickCount).toBe(1);
    const offBoard = card.behavioural.actualRankDistribution.find((b) => b.bucket === "off-board");
    expect(offBoard!.count).toBe(1);
  });

  it("reports null gaps rather than zero when nothing could be measured", () => {
    const card = build([entry({ provenanceClass: "test" })]);
    expect(card.behavioural.meanGapInRounds).toBeNull();
    expect(card.behavioural.medianGapInRounds).toBeNull();
  });
});

describe("rule-set identity (FR-011)", () => {
  it("carries the flattened constants", () => {
    const flat = flattenConstants();
    expect(flat["WEIGHT.bye"]).toBe(0.35);
    expect(flat["PREFERRED_CAP"]).toBe(1);
    expect(flat["SHORTLIST_SIZE"]).toBe(5);
  });

  it("takes the engine version from the caller, and does not compute it", () => {
    // It CANNOT compute it: the pure core has no filesystem, and the run script
    // executes under tsx where import.meta.glob does not exist. Passing it in
    // is the fix for the one HIGH finding /speckit-analyze raised here.
    const card = build([entry()]);
    expect(card.ruleSet.engineVersion).toBe("engine-abc123");
  });

  it("flattens numbers only — RELEVANCE is a rule, not a magnitude", () => {
    const flat = flattenConstants();
    for (const v of Object.values(flat)) expect(typeof v).toBe("number");
    expect(Object.keys(flat).some((k) => k.startsWith("RELEVANCE"))).toBe(false);
  });
});

describe("determinism", () => {
  it("hashes identically across builds", () => {
    expect(build([entry()]).hash).toBe(build([entry()]).hash);
  });

  it("changes its hash when the engine version changes", () => {
    // A rule change that left the constants alone must not compare as "nothing
    // happened".
    const a = buildScorecard({ considered: considered([entry()]), engineVersion: "v1" });
    const b = buildScorecard({ considered: considered([entry()]), engineVersion: "v2" });
    expect(a.hash).not.toBe(b.hash);
  });

  it("does not depend on the order entries were considered", () => {
    const one = entry({ id: "a-entry" });
    const two = entry({ id: "b-entry" });
    expect(build([one, two]).hash).toBe(build([two, one]).hash);
  });
});
