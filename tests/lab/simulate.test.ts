// 008 T056/T058 — the counterfactual draft, and the label that keeps it in its
// place.

import { describe, expect, it } from "vitest";
import { simulateDraft, type OpponentModel } from "../../src/lab/simulate";
import { observeAdpBehaviour } from "../../src/lab/behaviour";
import { bundle, entry } from "./helpers";

const model = (over: Partial<OpponentModel> = {}): OpponentModel => ({
  kind: "adp_noise",
  noiseSd: 3,
  grounded: true,
  seed: 42,
  ...over,
});

describe("reproducibility (FR-029, SC-007)", () => {
  it("gives an identical draft for the same seed", () => {
    const a = simulateDraft(entry(), bundle(), model());
    const b = simulateDraft(entry(), bundle(), model());
    expect(a.picks).toEqual(b.picks);
  });

  it("gives a different draft for a different seed", () => {
    const a = simulateDraft(entry(), bundle(), model({ seed: 1 }));
    const b = simulateDraft(entry(), bundle(), model({ seed: 2 }));
    expect(a.picks).not.toEqual(b.picks);
  });

  it("is unaffected by noise of zero being deterministic", () => {
    // With no noise the opponents take strict ADP order, which makes the whole
    // draft a fixed function of the board — a useful degenerate case for
    // isolating the engine's own behaviour.
    const a = simulateDraft(entry(), bundle(), model({ noiseSd: 0, seed: 1 }));
    const b = simulateDraft(entry(), bundle(), model({ noiseSd: 0, seed: 999 }));
    expect(a.picks).toEqual(b.picks);
  });
});

describe("the draft it produces", () => {
  it("never takes the same player twice", () => {
    const result = simulateDraft(entry(), bundle(), model());
    const ids = result.picks.map((p) => p.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("attributes each pick to the engine or an opponent", () => {
    const result = simulateDraft(entry(), bundle(), model());
    const mine = result.picks.filter((p) => p.by === "engine");
    expect(mine.length).toBeGreaterThan(0);
    for (const p of mine) expect(p.teamId).toBe(entry().myTeamId);
  });

  it("never drafts a keeper already held by another team", () => {
    const e = entry({ keepers: [{ teamId: 4, playerId: 1002 }] });
    const result = simulateDraft(e, bundle(), model());
    expect(result.picks.every((p) => p.playerId !== 1002)).toBe(true);
  });

  it("reports the owner's real roster beside the simulated one, on one measure", () => {
    const result = simulateDraft(entry(), bundle(), model());
    expect(result.engineRoster.length).toBeGreaterThan(0);
    expect(result.ownerRoster.length).toBeGreaterThan(0);
    for (const side of [result.engineRoster, result.ownerRoster]) {
      for (const p of side) {
        expect(p).toHaveProperty("position");
        expect(p).toHaveProperty("name");
      }
    }
  });
});

describe("it can never be mistaken for measured evidence (FR-031)", () => {
  it("is labelled model-dependent", () => {
    expect(simulateDraft(entry(), bundle(), model()).modelDependent).toBe(true);
  });

  it("carries the model identity and the seed", () => {
    const result = simulateDraft(entry(), bundle(), model({ seed: 7, noiseSd: 4.2 }));
    expect(result.model.kind).toBe("adp_noise");
    expect(result.model.seed).toBe(7);
    expect(result.model.noiseSd).toBe(4.2);
  });

  it("admits when its noise was not grounded in real data", () => {
    // If Gate 0 found no past-season drafts there is nothing to measure the
    // spread from, and a guessed parameter must say it is a guess rather than
    // wearing a measurement's clothes.
    expect(simulateDraft(entry(), bundle(), model({ grounded: false })).model.grounded).toBe(false);
  });

  it("produces no field a scorecard could consume", () => {
    // The structural half of FR-031: a simulation result has no `turns` and no
    // `behavioural`, so it cannot be dropped into `buildScorecard` and quietly
    // acquire a shadow replay's standing.
    const result = simulateDraft(entry(), bundle(), model()) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty("turns");
    expect(result).not.toHaveProperty("behavioural");
  });
});

describe("grounding the noise (FR-020c)", () => {
  it("measures the spread of real picks around ADP", () => {
    const e = entry({ useClass: "pick_sequence_only", unreplayableReason: "no board" });
    const adp = (playerId: number): number | null => playerId - 1000;
    const observed = observeAdpBehaviour([e], adp, null);
    expect(observed.sampleSize).toBe(e.picks.length);
    expect(observed.standardDeviation).not.toBeNull();
    // Every pick here is exactly at its ADP, so the spread is zero.
    expect(observed.standardDeviation).toBe(0);
  });

  it("treats a saturated ADP as ABSENT rather than as a real number", () => {
    // ESPN's ADP saturates — 325 of 522 players share a floor near 169.9. A
    // floor value means "no meaningful ADP", and counting it as one would
    // manufacture an enormous fictional spread, corrupting the very parameter
    // this measurement exists to set.
    const e = entry();
    const observed = observeAdpBehaviour([e], () => 169.9, 169.9);
    expect(observed.sampleSize).toBe(0);
    expect(observed.skippedNoAdp).toBe(e.picks.length);
    expect(observed.standardDeviation).toBeNull();
  });

  it("reports nulls rather than zeros when there is nothing to measure", () => {
    const observed = observeAdpBehaviour([], () => null, null);
    expect(observed.mean).toBeNull();
    expect(observed.standardDeviation).toBeNull();
    expect(observed.entriesUsed).toEqual([]);
  });

  it("names the entries it drew on", () => {
    const e = entry({ id: "past-2024" });
    const observed = observeAdpBehaviour([e], (id) => id - 1000, null);
    expect(observed.entriesUsed).toEqual(["past-2024"]);
  });
});
