// 008 T006 — the corpus invariants, written before the checks that satisfy them.
//
// A corpus is only as good as its refusal to load a bad entry. Every invariant
// here corresponds to a way a replay could produce confident, wrong numbers:
// a draft missing picks it does not admit to replays as a shorter draft; an
// entry with no owner team has no turns to observe; a test draft replays
// perfectly and is still not evidence.

import { describe, expect, it } from "vitest";
import {
  CORPUS_FORMAT_VERSION,
  exclusionReason,
  isAdmissible,
  validateEntry,
} from "../../src/lab/corpus";
import { entry, pick } from "./helpers";

const ok = (e: Parameters<typeof validateEntry>[0], hasSnapshot = true): string[] =>
  validateEntry(e, hasSnapshot).map((v) => v.invariant);

describe("validateEntry", () => {
  it("accepts a well-formed replayable entry", () => {
    expect(ok(entry())).toEqual([]);
  });

  it("refuses an unknown format version, and checks nothing else", () => {
    // Everything below the version check reads fields whose MEANING the version
    // governs. Reporting further violations would be interpreting bytes we do
    // not understand, and the extra findings would look like real problems.
    const violations = validateEntry(entry({ formatVersion: 99, myTeamId: null }), false);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.invariant).toBe("formatVersion");
    expect(violations[0]!.detail).toContain(String(CORPUS_FORMAT_VERSION));
  });

  it("catches picks that are out of order", () => {
    const e = entry({ picks: [pick({ overall: 2 }), pick({ overall: 1 })], totalPicks: 2 });
    expect(ok(e)).toContain("picks.sorted");
  });

  it("catches two picks sharing an overall number", () => {
    const e = entry({ picks: [pick({ overall: 1 }), pick({ overall: 1 })], totalPicks: 2 });
    expect(ok(e)).toContain("picks.unique");
  });

  it("catches a missing pick that gaps does not declare", () => {
    const picks = [1, 2, 4].map((n) => pick({ overall: n }));
    const e = entry({ picks, totalPicks: 4, gaps: [] });
    const found = ok(e);
    expect(found).toContain("picks.contiguous");
  });

  it("accepts the same hole once gaps declares it — but then refuses to replay", () => {
    const picks = [1, 2, 4].map((n) => pick({ overall: n }));
    const e = entry({ picks, totalPicks: 4, gaps: [3] });
    // Declared, so contiguity is satisfied…
    expect(ok(e)).not.toContain("picks.contiguous");
    // …and a partial draft is still not replayable.
    expect(ok(e)).toContain("replayable.gaps");
  });

  it("accepts a keeper league whose total differs from teams × rounds", () => {
    // The check reconciles against `totalPicks`, DELIBERATELY not against
    // teamCount × roundCount. In a keeper league those differ — keepers consume
    // slots that were never drafted — and 005 has that reconciliation open. An
    // entry that is internally consistent must not be rejected for failing an
    // assumption this feature declines to make.
    const picks = Array.from({ length: 10 }, (_, i) => pick({ overall: i + 1 }));
    const e = entry({ picks, totalPicks: 10, teamCount: 6, roundCount: 2 });
    expect(e.teamCount * e.roundCount).not.toBe(e.totalPicks);
    expect(ok(e)).toEqual([]);
  });

  it("catches totals that do not add up", () => {
    // A gap outside the draft's own length: contiguity passes (every pick from
    // 1 to totalPicks is present) while the arithmetic does not. Without this
    // check the entry would replay against a wrong number of remaining picks,
    // which is what drives the engine's forced/unsatisfiable verdicts.
    const picks = Array.from({ length: 12 }, (_, i) => pick({ overall: i + 1 }));
    const e = entry({ picks, totalPicks: 12, gaps: [13] });
    const found = ok(e);
    expect(found).toContain("totalPicks.reconciles");
    expect(found).not.toContain("picks.contiguous");
  });

  it("requires an owner team before an entry may be replayed", () => {
    expect(ok(entry({ myTeamId: null }))).toContain("replayable.myTeamId");
  });

  it("requires a pick order, and never guesses one", () => {
    expect(ok(entry({ order: [] }))).toContain("replayable.order");
  });

  it("requires an input snapshot", () => {
    expect(ok(entry(), false)).toContain("replayable.snapshot");
  });

  it("requires a pick_sequence_only entry to say why", () => {
    const e = entry({ useClass: "pick_sequence_only", unreplayableReason: null });
    expect(ok(e)).toContain("pick_sequence_only.reason");
  });

  it("accepts a pick_sequence_only entry with a reason, and does not demand a snapshot", () => {
    const e = entry({
      useClass: "pick_sequence_only",
      unreplayableReason: "no projection set exists for 2024",
      season: 2024,
    });
    expect(ok(e, false)).toEqual([]);
  });

  it("refuses a replayable entry that also carries an unreplayable reason", () => {
    expect(ok(entry({ unreplayableReason: "stale" }))).toContain("replayable.reason");
  });

  it("reports EVERY violation, not just the first", () => {
    // A corpus of ten drafts with three problems should report three problems.
    const e = entry({ myTeamId: null, order: [] });
    expect(ok(e, false).length).toBeGreaterThanOrEqual(3);
  });
});

describe("player ids are never filtered on sign", () => {
  it("accepts a D/ST pick at −16001", () => {
    // `playerId > 0` is what made 010's capture report 66 of 72 picks for a
    // complete draft. A D/ST id is a real player.
    const picks = [pick({ overall: 1, playerId: -16001 }), pick({ overall: 2 })];
    expect(ok(entry({ picks, totalPicks: 2 }))).toEqual([]);
  });

  it("accepts the −1 empty-slot sentinel as a distinct value", () => {
    // −1 means "nothing here", −16001 means "the Bears defence". Both are
    // negative and they mean opposite things; neither may be dropped by a sign
    // test that cannot tell them apart.
    const picks = [pick({ overall: 1, playerId: -1 }), pick({ overall: 2, playerId: -16001 })];
    const e = entry({ picks, totalPicks: 2 });
    expect(ok(e)).toEqual([]);
    expect(e.picks.map((p) => p.playerId)).toEqual([-1, -16001]);
  });
});

describe("admissibility", () => {
  it("admits an entry that is both replayable and real", () => {
    expect(isAdmissible(entry())).toBe(true);
    expect(exclusionReason(entry())).toBeNull();
  });

  it("refuses a test run even though it replays perfectly", () => {
    // THE trap this feature most needs to avoid. A mock draft is structurally
    // flawless and behaviourally meaningless: the room did not draft the way a
    // real room drafts, so tuning against it fits noise.
    const e = entry({ provenanceClass: "test" });
    expect(validateEntry(e, true)).toEqual([]);
    expect(isAdmissible(e)).toBe(false);
    expect(exclusionReason(e)).toContain("test run");
  });

  it("refuses a pick_sequence_only entry, and names the reason", () => {
    const e = entry({
      useClass: "pick_sequence_only",
      unreplayableReason: "no projection set exists for 2024",
    });
    expect(isAdmissible(e)).toBe(false);
    expect(exclusionReason(e)).toContain("no projection set exists for 2024");
  });

  it("never returns a silent exclusion", () => {
    for (const e of [entry({ provenanceClass: "test" }), entry({ useClass: "pick_sequence_only" })]) {
      expect(exclusionReason(e)).toBeTruthy();
    }
  });
});
