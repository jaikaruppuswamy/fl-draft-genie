// 011 T034 — ledger containment, and the recovery it must not break.
//
// BOTH CASES ARE WRITTEN IN THIS FILE ON PURPOSE. Rejecting contamination is
// trivial; rejecting it *without* breaking reload is the entire difficulty,
// because ledgers exist to restore a draft — 3 of 72 picks in 010's corpus
// arrived ONLY by ledger. A rule that rejects everything passes any suite
// written for the contamination case alone, and a rule that rejects nothing
// passes any suite written for the recovery case alone.
//
// The contamination is real: on 2026-08-06 a tab left open on a completed mock
// relayed that draft's full ledger into a freshly armed session, marking ~72
// available players as gone. It looked like it was working.

import { describe, expect, it } from "vitest";
import { initialState, reconcile, type DraftState } from "../../src/draft/reconcile";
import type { Observation, PickObservation } from "../../src/draft/feed";

const TEAMS = 6;
const ROUNDS = 12;
const TOTAL = TEAMS * ROUNDS;

function obs(over: Partial<Observation> = {}): Observation {
  return {
    picks: [],
    ledger: null,
    statuses: [],
    cursor: { receivedAt: "2026-08-06T00:00:00.000Z", id: "b1" },
    ...over,
  };
}

function pick(overall: number): PickObservation {
  return {
    teamId: ((overall - 1) % TEAMS) + 1,
    playerId: 1000 + overall,
    slot3: 0,
    overallPickNumber: overall,
    observedAt: new Date(Date.UTC(2026, 7, 6, 0, overall)).toISOString(),
    epoch: 1,
  };
}

/** A finished draft's ledger: every pick, arriving all at once. */
const completeLedger = Array.from({ length: TOTAL }, (_, i) => pick(i + 1));

function fresh(): DraftState {
  return initialState({ order: [1, 2, 3, 4, 5, 6], myTeamId: 1, totalPicks: TOTAL });
}

describe("a finished draft cannot be the first thing a session learns", () => {
  it("REJECTS a complete ledger at a session that has never seen a pick", () => {
    // The 2026-08-06 shape exactly.
    const { state } = reconcile(fresh(), obs({ ledger: completeLedger }));
    expect(state.picks).toHaveLength(0);
  });

  it("leaves the board untouched, so no available player is marked gone", () => {
    const { state } = reconcile(fresh(), obs({ ledger: completeLedger }));
    expect(state.confirmed).toHaveLength(0);
    expect(state.pending).toHaveLength(0);
  });

  it("emits no events for a rejected ledger", () => {
    // A rejected ledger must not look like 72 picks happening.
    const { events } = reconcile(fresh(), obs({ ledger: completeLedger }));
    expect(events).toHaveLength(0);
  });
});

describe("recovery still works — which is what ledgers are FOR (FR-026)", () => {
  it("ACCEPTS a ledger once the session has observed an incremental pick", () => {
    // The reload case: a draft in progress, the tab reloads, ESPN resends the
    // ledger. This must restore, or the containment rule has broken the thing
    // it was protecting.
    const started = reconcile(fresh(), obs({ picks: [pick(1)] })).state;
    expect(started.picks.length).toBeGreaterThan(0);

    const { state } = reconcile(started, obs({ ledger: completeLedger.slice(0, 10) }));
    expect(state.picks.length).toBeGreaterThan(1);
  });

  it("recovers picks that exist ONLY in a ledger", () => {
    // 010 measured 3 of 72 picks arriving by ledger alone. Losing those is a
    // silent hole in the middle of a draft.
    const started = reconcile(fresh(), obs({ picks: [pick(1)] })).state;
    const { state } = reconcile(started, obs({ ledger: [pick(1), pick(2), pick(3)] }));
    expect(state.picks.map((p) => p.overall)).toContain(3);
  });

  it("accepts a PARTIAL ledger at a fresh session — a live draft's ledger is partial", () => {
    // The signature is completeness, not the mere presence of a ledger. A live
    // draft's ledger arrives early and small, then the stream fills it in.
    const { state } = reconcile(fresh(), obs({ ledger: completeLedger.slice(0, 3) }));
    expect(state.picks.length).toBeGreaterThan(0);
  });
});

describe("the rule does not rest on coverage alone (FR-024)", () => {
  it("prefers the larger of two ledgers FOR THE SAME DRAFT", () => {
    // Coverage remains correct for what it was built for: a tap flushing after
    // an outage sends an old snapshot with a new timestamp, and the fuller one
    // should win. What it must not do is let a finished draft win outright.
    const started = reconcile(fresh(), obs({ picks: [pick(1)] })).state;
    const small = reconcile(started, obs({ ledger: completeLedger.slice(0, 4) })).state;
    const large = reconcile(small, obs({ ledger: completeLedger.slice(0, 9) })).state;
    expect(large.picks.length).toBeGreaterThanOrEqual(small.picks.length);
  });
});

describe("the guard can fail", () => {
  it("PROVES rejection is conditional, not blanket", () => {
    // Without this, "rejects a complete ledger" passes against an implementation
    // that rejects every ledger ever — which would break every reload.
    const fromFresh = reconcile(fresh(), obs({ ledger: completeLedger })).state;
    const started = reconcile(fresh(), obs({ picks: [pick(1)] })).state;
    const fromStarted = reconcile(started, obs({ ledger: completeLedger.slice(0, 10) })).state;

    expect(fromFresh.picks).toHaveLength(0);
    expect(fromStarted.picks.length).toBeGreaterThan(0);
  });
});

describe("the refusal is RECORDED, not silent (FR-025, SC-007)", () => {
  it("reports why the ledger was refused", () => {
    // Without this, a rejected ledger and a ledger that simply never arrived
    // are indistinguishable afterwards — and one of those is a bug.
    const r = reconcile(fresh(), obs({ ledger: completeLedger }));
    expect(r.rejectedLedger).toBeDefined();
    expect(r.rejectedLedger?.reason).toBe("complete_ledger_at_unstarted_session");
    expect(r.rejectedLedger?.rows).toBe(TOTAL);
  });

  it("records nothing when a ledger is accepted", () => {
    const started = reconcile(fresh(), obs({ picks: [pick(1)] })).state;
    expect(reconcile(started, obs({ ledger: completeLedger.slice(0, 5) })).rejectedLedger).toBeUndefined();
  });

  it("does not judge completeness when the draft's length is unknown", () => {
    // `totalPicks === 0` means not yet established. Treating it as a real total
    // is the same mistake 006 made reading an unknown as a claim — it would
    // refuse every ledger in a session that has not received pre-draft data.
    const unknownLength = initialState({ order: [1, 2, 3, 4, 5, 6], myTeamId: 1, totalPicks: 0 });
    const r = reconcile(unknownLength, obs({ ledger: completeLedger }));
    expect(r.rejectedLedger).toBeUndefined();
    expect(r.state.picks.length).toBeGreaterThan(0);
  });
});

describe("the tap's direct report (011 T038, research §2)", () => {
  // The tap is attached to the room; it does not have to infer what the room is
  // showing. Authoritative when present — and never depended on alone, since
  // taps update on their own schedule.
  const finished = [{ state: "draft-finished", observedAt: "2026-08-06T00:00:00.000Z" }];

  it("rejects on the tap's report even when the ledger looks PARTIAL", () => {
    // Shape alone cannot catch this: a partial ledger at a fresh session is the
    // normal start of a live draft. Only the tap knows the room is finished.
    const r = reconcile(fresh(), obs({ ledger: completeLedger.slice(0, 3), statuses: finished }));
    expect(r.state.picks).toHaveLength(0);
    expect(r.rejectedLedger?.reason).toBe("tap_reported_finished_draft");
  });

  it("rejects on the tap's report even when the draft's LENGTH is unknown", () => {
    // The case that matters most in practice: a freshly reconnected session has
    // no pre-draft data, so `totalPicks` is 0 and the inference cannot fire —
    // and that is exactly when a stale tab's ledger arrives.
    const unknownLength = initialState({ order: [1, 2, 3, 4, 5, 6], myTeamId: 1, totalPicks: 0 });
    const r = reconcile(unknownLength, obs({ ledger: completeLedger, statuses: finished }));
    expect(r.state.picks).toHaveLength(0);
    expect(r.rejectedLedger?.reason).toBe("tap_reported_finished_draft");
  });

  it("does NOT break recovery — a session with picks still accepts", () => {
    // The end of a real draft: the tap correctly reports finished, and the
    // ledger for THIS draft arrives. Refusing here would discard the last picks
    // of every draft, at the moment they matter most.
    const started = reconcile(fresh(), obs({ picks: [pick(1)] })).state;
    const r = reconcile(started, obs({ ledger: completeLedger, statuses: finished }));
    expect(r.state.picks.length).toBeGreaterThan(1);
    expect(r.rejectedLedger).toBeUndefined();
  });

  it("is not depended on ALONE — the inference still fires without any report", () => {
    // An older tap sends no such status. The 2026-08-06 contamination must
    // still be caught for every tap that has not updated.
    const r = reconcile(fresh(), obs({ ledger: completeLedger, statuses: [] }));
    expect(r.state.picks).toHaveLength(0);
    expect(r.rejectedLedger?.reason).toBe("complete_ledger_at_unstarted_session");
  });

  it("ignores unrelated statuses", () => {
    // Any status arriving must not become a rejection signal.
    const noisy = [{ state: "relaying", observedAt: "2026-08-06T00:00:00.000Z" }];
    const r = reconcile(fresh(), obs({ ledger: completeLedger.slice(0, 3), statuses: noisy }));
    expect(r.state.picks.length).toBeGreaterThan(0);
    expect(r.rejectedLedger).toBeUndefined();
  });
});
