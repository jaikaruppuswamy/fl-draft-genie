// 006 T051/T052 — US4: degrade visibly, never silently.
//
// The distinction these tests protect is one the SPEC ITSELF had to be
// corrected on: a stale DRAFT STATE and a stale PLAYER BOARD are different
// failures with opposite handling.
//
//   draft state stale  →  WITHHOLD. Picks are provably being missed, so any
//                         ranking is against data known to be wrong (FR-012).
//   player board stale →  SURFACE. Week-old projections still rank
//                         meaningfully; refusing to answer would be worse than
//                         answering with a note (US4 AS3).
//
// A plausible implementation collapses both into one "stale" flag, and the
// collapse is invisible until draft day.

import { describe, expect, it } from "vitest";
import { recommend } from "../../src/engine/recommend";
import { makeBundle, makeState } from "./helpers";
import type { SignalKind } from "../../src/engine/types";

describe("SC-008 — missing signals degrade, they do not stop the ranking", () => {
  it("still ranks every player when a signal is entirely absent", () => {
    const full = makeBundle();
    const stripped = makeBundle();
    stripped.players = full.players;
    stripped.proTeamByPlayer = full.proTeamByPlayer;
    stripped.signals = new Map();

    const board = recommend(stripped, makeState(stripped, { picksMade: 10 }));
    expect(board.withheld).toBeNull();
    expect(board.entries).toHaveLength(recommend(full, makeState(full, { picksMade: 10 })).entries.length);
    expect(board.shortlist.length).toBeGreaterThan(0);
  });

  it("names the missing input in the explanation (FR-013)", () => {
    const stripped = makeBundle();
    stripped.signals = new Map();
    const board = recommend(stripped, makeState(stripped, { picksMade: 10 }));
    const missing = board.shortlist.flatMap((s) => s.explanation.missing.map((m) => m.input));
    expect(missing).toContain("offense");
    expect(missing).toContain("sos");
  });

  it("degrades PER PLAYER when only some are missing a rating", () => {
    // The subset case SC-008 actually specifies: some players have signals,
    // some do not, and both must appear in the same ranking.
    const bundle = makeBundle();
    const partial = new Map(bundle.signals);
    const offense = new Map(partial.get("offense")!);
    // Drop half the league's teams.
    for (let team = 1; team <= 16; team++) offense.delete(team);
    partial.set("offense", offense);
    bundle.signals = partial;

    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const withMissing = board.shortlist.filter((s) =>
      s.explanation.missing.some((m) => m.input === "offense"),
    );
    const withSignal = board.shortlist.filter((s) =>
      s.explanation.adjustments.some((a) => a.rule === "offense"),
    );
    // Both kinds are present, and both are ranked.
    expect(withMissing.length + withSignal.length).toBe(board.shortlist.length);
    expect(board.entries.length).toBeGreaterThan(100);
  });

  it("warns at the board level about which signals are gone", () => {
    const bundle = makeBundle();
    bundle.signals = new Map([["sos", bundle.signals.get("sos")!]] as [
      SignalKind,
      Map<number, import("../../src/engine/types").SignalValue>,
    ][]);
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const warning = board.warnings.find((w) => w.kind === "signals_missing")!;
    expect(warning).toBeDefined();
    expect(warning.detail).toMatch(/offense/);
    expect(warning.detail).toMatch(/oline/);
    expect(warning.detail).not.toMatch(/sos/);
  });
});

describe("a stale player board is SURFACED, not withheld (US4 AS1/AS3)", () => {
  it("still produces a full ranking", () => {
    const bundle = makeBundle();
    bundle.freshness = { fetchedAt: "2026-07-01T00:00:00.000Z", stale: true };
    const board = recommend(bundle, makeState(bundle, { picksMade: 5 }));
    expect(board.withheld).toBeNull();
    expect(board.entries.length).toBeGreaterThan(100);
    expect(board.shortlist.length).toBeGreaterThan(0);
  });

  it("says so, alongside the results", () => {
    const bundle = makeBundle();
    bundle.freshness = { fetchedAt: "2026-07-01T00:00:00.000Z", stale: true };
    const board = recommend(bundle, makeState(bundle, { picksMade: 5 }));
    const warning = board.warnings.find((w) => w.kind === "board_stale")!;
    expect(warning).toBeDefined();
    expect(warning.detail).toContain("2026-07-01");
  });

  it("says nothing when the board is fresh", () => {
    const bundle = makeBundle();
    const board = recommend(bundle, makeState(bundle, { picksMade: 5 }));
    expect(board.warnings.find((w) => w.kind === "board_stale")).toBeUndefined();
  });
});

describe("a stale DRAFT STATE withholds (FR-012, SC-007)", () => {
  it("returns no recommendation and states the reason", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, {
      picksMade: 20,
      withholding: { reason: "not_receiving", detail: "No tap heartbeat for 61s" },
    });
    const board = recommend(bundle, state);
    expect(board.withheld).toEqual({ reason: "not_receiving", detail: "No tap heartbeat for 61s" });
    expect(board.entries).toEqual([]);
    expect(board.shortlist).toEqual([]);
  });

  it("withholds for every reason 005 can report", () => {
    const bundle = makeBundle();
    for (const reason of ["not_receiving", "incompatible", "version_rejected"]) {
      const board = recommend(
        bundle,
        makeState(bundle, { picksMade: 20, withholding: { reason, detail: "d" } }),
      );
      expect(board.entries, reason).toEqual([]);
      expect(board.withheld!.reason).toBe(reason);
    }
  });

  it("still reports the revision, so a consumer can tell WHICH state was refused", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, {
      picksMade: 3,
      withholding: { reason: "not_receiving", detail: "d" },
    });
    expect(recommend(bundle, state).revision).toBe(state.revision);
  });

  it("does NOT withhold merely because the board is also stale", () => {
    // The two must stay independent. Collapsing them would make a week-old
    // projection set silence the engine during a perfectly healthy draft.
    const bundle = makeBundle();
    bundle.freshness = { fetchedAt: "2026-07-01T00:00:00.000Z", stale: true };
    expect(recommend(bundle, makeState(bundle, { picksMade: 5 })).withheld).toBeNull();
  });
});

describe("the mandatory-slot warnings (FR-025)", () => {
  it("warns while slots are unfilled but picks remain", () => {
    const bundle = makeBundle();
    const board = recommend(bundle, makeState(bundle, { picksMade: 0 }));
    const w = board.warnings.find((x) => x.kind === "mandatory_unfilled")!;
    expect(w).toBeDefined();
    expect(w.detail).toMatch(/still unfilled/);
    expect(board.forced).toBe(false);
  });

  it("reports the unsatisfiable case plainly, and still ranks", () => {
    const bundle = makeBundle();
    const state = makeState(bundle, { picksMade: 0 });
    // Eight mandatory slots, one pick left.
    const doomed = { ...state, myRemainingPicks: 1, myRoster: [] };
    const board = recommend(bundle, doomed);
    const w = board.warnings.find((x) => x.kind === "mandatory_unsatisfiable")!;
    expect(w).toBeDefined();
    expect(w.detail).toMatch(/cannot be completed/);
    // Still ranks — saying nothing here helps nobody.
    expect(board.entries.length).toBeGreaterThan(100);
  });
});
