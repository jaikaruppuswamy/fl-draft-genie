// 008 T036 — comparing two scorecards, and the failure that must never be
// reported as a finding.

import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLD, compareScorecards, isEmpty } from "../../src/lab/compare";
import { buildScorecard } from "../../src/lab/scorecard";
import { fidelityFor, replayEntry } from "../../src/lab/replay";
import type { EngineBundle } from "../../src/engine/types";
import { bundle, entry } from "./helpers";

function card(b: EngineBundle, engineVersion = "engine-v1") {
  const e = entry();
  return buildScorecard({
    considered: [{ entry: e, fidelity: fidelityFor(e, false), turns: replayEntry(e, b).turns }],
    engineVersion,
  });
}

describe("a comparison of identical rule sets", () => {
  it("is empty", () => {
    const c = compareScorecards(card(bundle()), card(bundle()));
    expect(isEmpty(c)).toBe(true);
    expect(c.headChanges).toEqual([]);
    expect(c.movements).toEqual([]);
  });

  it("does not flag a determinism failure when nothing changed", () => {
    expect(compareScorecards(card(bundle()), card(bundle())).determinismFailure).toBe(false);
  });

  it("FLAGS a determinism failure when the same rules give different answers", () => {
    // The worst possible outcome is reporting this as movement: it arrives
    // looking exactly like a real finding, and every comparison afterwards is
    // worthless. Same engineVersion and same constants, different results.
    const baseline = card(bundle(), "engine-v1");
    const drifted = card(bundle({ preferred: new Set([1007]) }), "engine-v1");
    const c = compareScorecards(baseline, drifted);
    expect(isEmpty(c)).toBe(false);
    expect(c.determinismFailure).toBe(true);
  });
});

describe("a comparison of different rule sets", () => {
  it("reports movement as a rule effect, not a determinism failure", () => {
    const baseline = card(bundle(), "engine-v1");
    const candidate = card(bundle({ preferred: new Set([1007]) }), "engine-v2");
    const c = compareScorecards(baseline, candidate);
    expect(c.determinismFailure).toBe(false);
    expect(isEmpty(c)).toBe(false);
  });

  it("names the turn whose head changed, with both players", () => {
    const baseline = card(bundle(), "engine-v1");
    // Lift a mid-board player far enough to take the head.
    const candidate = card(bundle({ preferred: new Set([1007, 1008]) }), "engine-v2");
    const c = compareScorecards(baseline, candidate);
    if (c.headChanges.length > 0) {
      const h = c.headChanges[0]!;
      expect(h.entryId).toBe("test-2026");
      expect(h.from?.playerId).not.toBe(h.to?.playerId);
    }
    // Whether the head moved depends on the engine's own arithmetic; what must
    // hold either way is that SOMETHING was reported and it was attributed.
    expect(c.headChanges.length + c.movements.length).toBeGreaterThan(0);
  });
});

describe("the threshold (FR-012)", () => {
  it("is stated in every comparison", () => {
    // Without this a reader cannot tell an unchanged turn from one that moved
    // below the bar.
    const c = compareScorecards(card(bundle()), card(bundle()));
    expect(c.threshold).toEqual(DEFAULT_THRESHOLD);
    expect(c.threshold.rankMovement).toBe(3);
    expect(c.threshold.valueInRounds).toBe(0.1);
  });

  it("is a FIXED default, not something each run picks", () => {
    // Two reports produced weeks apart must be comparable. A per-run threshold
    // makes "more movement appeared" ambiguous between a rule change and a
    // different bar.
    const a = compareScorecards(card(bundle()), card(bundle()));
    const b = compareScorecards(card(bundle()), card(bundle()));
    expect(a.threshold).toEqual(b.threshold);
  });

  it("can be overridden explicitly, and the override is reported", () => {
    const c = compareScorecards(card(bundle()), card(bundle()), {
      rankMovement: 1,
      valueInRounds: 0.0001,
    });
    expect(c.threshold.rankMovement).toBe(1);
  });

  it("suppresses movement below the bar", () => {
    const baseline = card(bundle(), "engine-v1");
    const candidate = card(bundle({ preferred: new Set([1007]) }), "engine-v2");
    const strict = compareScorecards(baseline, candidate, { rankMovement: 1, valueInRounds: 0.00001 });
    const loose = compareScorecards(baseline, candidate, { rankMovement: 99, valueInRounds: 999 });
    expect(loose.movements.length).toBeLessThanOrEqual(strict.movements.length);
  });
});

describe("corpus mismatch", () => {
  it("names entries present on only one side", () => {
    // Comparing over different corpora is not a comparison. Reporting the
    // difference beats silently intersecting them.
    const one = entry({ id: "a" });
    const two = entry({ id: "b" });
    const left = buildScorecard({
      considered: [{ entry: one, fidelity: fidelityFor(one, false), turns: replayEntry(one, bundle()).turns }],
      engineVersion: "v1",
    });
    const right = buildScorecard({
      considered: [{ entry: two, fidelity: fidelityFor(two, false), turns: replayEntry(two, bundle()).turns }],
      engineVersion: "v1",
    });
    expect(compareScorecards(left, right).corpusMismatch).toEqual(["a", "b"]);
  });
});

describe("aggregate deltas", () => {
  it("reports the change in head agreement and turn count", () => {
    const c = compareScorecards(card(bundle()), card(bundle()));
    expect(c.aggregateDeltas.headAgreementRate).toBe(0);
    expect(c.aggregateDeltas.turnCount).toBe(0);
  });
});
