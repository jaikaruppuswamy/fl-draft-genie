// 005 — the fingerprint's exclusions are the point (FR-014, research §7).

import { describe, expect, it } from "vitest";
import { stateFingerprint } from "../../src/draft/fingerprint";
import { initialState, type DraftState } from "../../src/draft/reconcile";

const pick = (overall: number, teamId: number, playerId: number) => ({
  overall,
  teamId,
  playerId,
  slot3: 0,
  observedAt: "2026-08-30T23:14:07.221Z",
  epoch: 0,
});

const s = (over: Partial<DraftState> = {}): DraftState =>
  initialState({ order: [5, 2, 1], myTeamId: 1, totalPicks: 36, picks: [pick(1, 5, 100), pick(2, 2, 101)], ...over });

describe("stateFingerprint", () => {
  it("is equal for two states holding the same draft", () => {
    expect(stateFingerprint(s())).toBe(stateFingerprint(s()));
  });

  it("IGNORES delivery bookkeeping — a rebuild provably cannot reproduce it", () => {
    // Replaying the log collapses N observations into however many reads the
    // rebuild takes, so the event stream differs even when the draft does not.
    // Including seq here would make FR-014 unsatisfiable by construction.
    expect(stateFingerprint(s({ seq: 0 }))).toBe(stateFingerprint(s({ seq: 412 })));
  });

  it("ignores how the picks were sourced", () => {
    // Same draft, reached by ledger vs by stream: the split between confirmed
    // and pending is an implementation detail of the intake.
    const viaStream = s({ confirmed: [], pending: [pick(1, 5, 100), pick(2, 2, 101)] });
    const viaLedger = s({ confirmed: [pick(1, 5, 100), pick(2, 2, 101)], pending: [] });
    expect(stateFingerprint(viaStream)).toBe(stateFingerprint(viaLedger));
  });

  it("DIFFERS when a pick differs", () => {
    expect(stateFingerprint(s())).not.toBe(stateFingerprint(s({ picks: [pick(1, 5, 100), pick(2, 2, 999)] })));
  });

  it("differs when a pick is missing", () => {
    expect(stateFingerprint(s())).not.toBe(stateFingerprint(s({ picks: [pick(1, 5, 100)] })));
  });

  it("differs on the revision, so a correction is never mistaken for the same state", () => {
    expect(stateFingerprint(s())).not.toBe(stateFingerprint(s({ revision: 1 })));
  });

  it("differs on completion", () => {
    expect(stateFingerprint(s())).not.toBe(stateFingerprint(s({ complete: true })));
  });

  it("is independent of the picks' array order", () => {
    const reversed = s({ picks: [pick(2, 2, 101), pick(1, 5, 100)] });
    expect(stateFingerprint(reversed)).toBe(stateFingerprint(s()));
  });
});
