// 005 T014 — the reducer. The heart of the feature.
//
// The properties here are the ones a plausible implementation gets wrong
// quietly: idempotency (a replayed batch must be free), the union of ledger and
// stream (either alone is incomplete — 3 of 72 real picks existed only in a
// ledger), and exactly-once turn events scoped per revision.

import { describe, expect, it } from "vitest";
import { initialState, reconcile, frontier, type DraftState } from "../../src/draft/reconcile";
import type { Observation, PickObservation } from "../../src/draft/feed";

const ORDER = [5, 2, 1, 3, 6, 4];

const pick = (teamId: number, playerId: number, over: Partial<PickObservation> = {}): PickObservation => ({
  teamId,
  playerId,
  slot3: 0,
  observedAt: "2026-08-30T23:14:07.221Z",
  epoch: 0,
  ...over,
});

const obs = (o: Partial<Observation> = {}): Observation => ({
  picks: [],
  ledger: null,
  statuses: [],
  cursor: { receivedAt: "", id: "" },
  ...o,
});

const base = (over: Partial<DraftState> = {}) =>
  initialState({ order: ORDER, myTeamId: 1, totalPicks: 72, ...over });

describe("append", () => {
  it("appends an incremental pick and emits pick_made", () => {
    const r = reconcile(base(), obs({ picks: [pick(5, 100)] }));
    expect(r.state.picks).toHaveLength(1);
    expect(r.state.picks[0]).toMatchObject({ overall: 1, teamId: 5, playerId: 100 });
    expect(r.events.filter((e) => e.kind === "pick_made")).toHaveLength(1);
  });

  it("derives the overall number, because SELECTED carries no ordinal", () => {
    let s = base();
    for (const [i, p] of [pick(5, 100), pick(2, 101), pick(1, 102)].entries()) {
      const r = reconcile(s, obs({ picks: [p] }));
      s = r.state;
      expect(s.picks.at(-1)!.overall).toBe(i + 1);
    }
  });

  it("keeps D/ST picks, whose ids are legitimately negative", () => {
    const r = reconcile(base(), obs({ picks: [pick(4, -16007)] }));
    expect(r.state.picks[0]!.playerId).toBe(-16007);
  });

  it("carries slot3 opaquely and never derives a round from it", () => {
    const r = reconcile(base(), obs({ picks: [pick(5, 100, { slot3: 7 })] }));
    expect(r.state.picks[0]!.slot3).toBe(7);
    expect(r.state.picks[0]).not.toHaveProperty("round");
  });
});

describe("idempotency (FR-010)", () => {
  it("produces ZERO events when the same batch is replayed", () => {
    // A safety-alarm sweep finding the cursor already current, or a re-read
    // after a crash. Must be free, or the session commits on every tick.
    const first = reconcile(base(), obs({ picks: [pick(5, 100)] }));
    const again = reconcile(first.state, obs({ picks: [pick(5, 100)] }));
    expect(again.events).toEqual([]);
    expect(again.state).toBe(first.state); // same object: nothing to commit
  });

  it("collapses the same pick arriving from two tabs", () => {
    // Two draft-room tabs relay one draft as two sequences of the same picks.
    const r = reconcile(base(), obs({ picks: [pick(5, 100), pick(5, 100)] }));
    expect(r.state.picks).toHaveLength(1);
  });

  it("is free when a ledger merely restates what the stream already delivered", () => {
    const first = reconcile(base(), obs({ picks: [pick(5, 100), pick(2, 101)] }));
    const again = reconcile(
      first.state,
      obs({ ledger: [pick(5, 100, { overallPickNumber: 1 }), pick(2, 101, { overallPickNumber: 2 })] }),
    );
    expect(again.events).toEqual([]);
  });
});

describe("the ledger is authoritative and completes the stream", () => {
  it("recovers picks the incremental stream never delivered", () => {
    // The real case: 69 of 72 picks arrived as frames, 3 existed ONLY in a
    // ledger. Either source counted alone is incomplete.
    const streamed = reconcile(base(), obs({ picks: [pick(5, 100), pick(2, 101)] }));
    const withLedger = reconcile(
      streamed.state,
      obs({
        ledger: [
          pick(5, 100, { overallPickNumber: 1 }),
          pick(2, 101, { overallPickNumber: 2 }),
          pick(1, 102, { overallPickNumber: 3 }),
        ],
      }),
    );
    expect(withLedger.state.picks.map((p) => p.playerId)).toEqual([100, 101, 102]);
  });

  it("preserves the FIRST observed_at, so a rebuild does not flatten timing", () => {
    const first = reconcile(base(), obs({ picks: [pick(5, 100, { observedAt: "2026-08-30T23:00:00.000Z" })] }));
    const later = reconcile(
      first.state,
      obs({ ledger: [pick(5, 100, { overallPickNumber: 1, observedAt: "2026-08-30T23:59:00.000Z" })] }),
    );
    expect(later.state.picks[0]!.observedAt).toBe("2026-08-30T23:00:00.000Z");
  });
});

describe("corrections bump the revision (FR-012)", () => {
  it("bumps when a ledger replaces a pick we had recorded", () => {
    const first = reconcile(base(), obs({ picks: [pick(5, 100), pick(2, 101)] }));
    expect(first.state.revision).toBe(0);
    const corrected = reconcile(
      first.state,
      obs({ ledger: [pick(5, 100, { overallPickNumber: 1 }), pick(2, 999, { overallPickNumber: 2 })] }),
    );
    expect(corrected.state.revision).toBe(1);
    expect(corrected.state.picks[1]!.playerId).toBe(999);
  });

  it("does NOT bump on a pure forward append", () => {
    const first = reconcile(base(), obs({ picks: [pick(5, 100)] }));
    const second = reconcile(first.state, obs({ picks: [pick(2, 101)] }));
    expect(second.state.revision).toBe(0);
  });

  it("carries the revision on every event, so consumers can dedupe on it", () => {
    const first = reconcile(base(), obs({ picks: [pick(5, 100), pick(2, 101)] }));
    const corrected = reconcile(
      first.state,
      obs({ ledger: [pick(5, 100, { overallPickNumber: 1 }), pick(2, 999, { overallPickNumber: 2 })] }),
    );
    for (const e of corrected.events) expect(e.revision).toBe(1);
  });
});

describe("turn events (SC-003)", () => {
  /** Drive the draft to `n` picks with throwaway player ids. */
  const advance = (s: DraftState, n: number) => {
    let cur = s;
    const all: ReturnType<typeof reconcile>["events"] = [];
    for (let i = cur.picks.length; i < n; i++) {
      const r = reconcile(cur, obs({ picks: [pick(0, 1000 + i)] }));
      cur = r.state;
      all.push(...r.events);
    }
    return { state: cur, events: all };
  };

  it("fires on_deck exactly once before on_the_clock for the owner's turn", () => {
    // Team 1 holds overall 3 in this order.
    const { events } = advance(base(), 3);
    const deck = events.filter((e) => e.kind === "on_deck");
    const clock = events.filter((e) => e.kind === "on_the_clock");
    expect(deck).toHaveLength(1);
    expect(clock).toHaveLength(1);
    expect(events.indexOf(deck[0]!)).toBeLessThan(events.indexOf(clock[0]!));
  });

  it("carries the REAL picksUntil, never a flat two", () => {
    // Team 1 holds overall 3, so the two-away moment exists only BEFORE any
    // pick has landed — and events only fire on a state change. The earliest
    // opportunity is therefore one pick out, and the event says so rather than
    // claiming a lead it never had.
    const { events } = advance(base(), 3);
    const deck = events.find((e) => e.kind === "on_deck")!;
    expect(deck).toMatchObject({ overall: 3, picksUntil: 1 });
  });

  it("DOES fire two ahead when the structure allows it", () => {
    // Team 4 holds overall 6, so after pick 3 the owner is genuinely two away.
    const { events } = advance(base({ myTeamId: 4 }), 4);
    const deck = events.find((e) => e.kind === "on_deck")!;
    expect(deck).toMatchObject({ overall: 6, picksUntil: 2 });
  });

  it("fires with ZERO lead at a snake boundary, where any lead is impossible", () => {
    // Team 4 picks overall 6 and 7 back-to-back. Turn 7 only BECOMES the
    // owner's next turn once pick 6 lands — at which point they are already on
    // the clock. There is no earlier moment, so the honest payload is 0.
    //
    // This is precisely why clarification round 2 made the guarantee ORDINAL
    // ("as early as the draft's structure allows, at most two picks ahead")
    // and had the event carry the real picks_until of 2, 1 **or 0**, rather
    // than promising a fixed two-pick lead the snake cannot always provide.
    // 006 pre-computes its second pick off on_the_clock for this reason.
    const { events } = advance(base({ myTeamId: 4 }), 7);
    const second = events.filter((e) => e.kind === "on_deck").find((e) => e.overall === 7);
    expect(second).toMatchObject({ picksUntil: 0 });
    // Still exactly once, and still before its on_the_clock.
    const clock7 = events.find((e) => e.kind === "on_the_clock" && e.overall === 7);
    expect(events.indexOf(second!)).toBeLessThan(events.indexOf(clock7!));
  });

  it("never fires more than once per turn per revision", () => {
    const { events } = advance(base(), 12);
    const byTurn = new Map<number, number>();
    for (const e of events) {
      if (e.kind !== "on_deck") continue;
      byTurn.set(e.overall, (byTurn.get(e.overall) ?? 0) + 1);
    }
    for (const [turn, n] of byTurn) expect(n, `turn ${turn}`).toBe(1);
  });

  it("emits NO turn events when the order is unknown", () => {
    // A countdown against an unknown order is a guess. FR-017.
    const s = initialState({ order: [], myTeamId: 1, totalPicks: 72 });
    const { events } = reconcile(s, obs({ picks: [pick(5, 100)] }));
    expect(events.filter((e) => e.kind === "on_deck" || e.kind === "on_the_clock")).toEqual([]);
  });
});

describe("completion", () => {
  it("emits draft_complete exactly once when the total is reached", () => {
    const s = initialState({ order: ORDER, myTeamId: 1, totalPicks: 3 });
    const r1 = reconcile(s, obs({ picks: [pick(5, 1), pick(2, 2)] }));
    expect(r1.events.some((e) => e.kind === "draft_complete")).toBe(false);
    const r2 = reconcile(r1.state, obs({ picks: [pick(1, 3)] }));
    expect(r2.events.filter((e) => e.kind === "draft_complete")).toHaveLength(1);
    const r3 = reconcile(r2.state, obs({ picks: [pick(1, 3)] }));
    expect(r3.events).toEqual([]);
  });

  it("never completes while the total is unknown", () => {
    // 0 means "not yet known" and must never be treated as a total — a false
    // complete stops the relay.
    const s = initialState({ order: ORDER, myTeamId: 1, totalPicks: 0 });
    const r = reconcile(s, obs({ picks: [pick(5, 1)] }));
    expect(r.state.complete).toBe(false);
    expect(r.events.some((e) => e.kind === "draft_complete")).toBe(false);
  });
});

describe("frontier", () => {
  it("is the lowest pick not yet made", () => {
    expect(frontier(base())).toBe(1);
    expect(frontier(reconcile(base(), obs({ picks: [pick(5, 100)] })).state)).toBe(2);
  });
});

describe("a ledger that is STALER than the stream (regression)", () => {
  // This lost picks outright. The old merge keyed on `overall` only, so when a
  // dropped frame had shifted the derived numbering, a truthful ledger evicted
  // whatever the stream had parked at the slots it restated — silently, and
  // still dense, so nothing detected it.
  //
  // Reachable in normal operation: two tabs relaying one league is supported
  // (010 SC-013), their batches interleave in one cursor read, and the tap's
  // 750 ms batch window and durable buffer both put a ledger behind the stream.
  const streamThenLedger = (dropped: number) => {
    let s = base();
    const real = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011];
    for (const pid of real) {
      if (pid === dropped) continue; // tab A's socket dropped this frame
      s = reconcile(s, obs({ picks: [pick(0, pid)] })).state;
    }
    // Tab B's INIT ledger, truthful, covering real picks 1..8.
    const ledger = real.slice(0, 8).map((pid, i) => pick(0, pid, { overallPickNumber: i + 1 }));
    return reconcile(s, obs({ ledger }));
  };

  it("LOSES NOTHING when the ledger lags the stream", () => {
    const r = streamThenLedger(1003);
    expect(r.state.picks).toHaveLength(11);
    expect(r.state.picks.some((p) => p.playerId === 1009)).toBe(true);
  });

  it("renumbers the tail correctly instead of leaving it shifted", () => {
    const r = streamThenLedger(1003);
    expect(r.state.picks.map((p) => p.playerId)).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011,
    ]);
    expect(frontier(r.state)).toBe(12);
  });

  it("survives two dropped frames, not just one", () => {
    let s = base();
    for (const pid of [1001, 1002, 1005, 1006, 1007, 1008, 1009, 1010]) {
      s = reconcile(s, obs({ picks: [pick(0, pid)] })).state;
    }
    const ledger = [1001, 1002, 1003, 1004, 1005, 1006].map((pid, i) =>
      pick(0, pid, { overallPickNumber: i + 1 }),
    );
    const r = reconcile(s, obs({ ledger }));
    expect(r.state.picks.map((p) => p.playerId)).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]);
  });

  it("still treats a ledger that merely confirms the stream as a no-op", () => {
    // The benign direction must stay free, or every sweep commits.
    let s = base();
    for (const pid of [1001, 1002, 1003]) s = reconcile(s, obs({ picks: [pick(0, pid)] })).state;
    const ledger = [1001, 1002, 1003].map((pid, i) => pick(0, pid, { overallPickNumber: i + 1 }));
    const r = reconcile(s, obs({ ledger }));
    expect(r.events).toEqual([]);
    expect(r.state.revision).toBe(0);
  });
});

describe("gaps a broken implementation used to slip through", () => {
  const advance = (s: DraftState, n: number, from = 3000) => {
    let cur = s;
    const all: ReturnType<typeof reconcile>["events"] = [];
    for (let i = cur.picks.length; i < n; i++) {
      const r = reconcile(cur, obs({ picks: [pick(0, from + i)] }));
      cur = r.state;
      all.push(...r.events);
    }
    return { state: cur, events: all };
  };

  it("RE-FIRES the affected turn events under the new revision after a correction", () => {
    // Suppressing turn events after a correction entirely used to keep the
    // whole suite green. In production that means: a ledger corrects a pick
    // below the owner's upcoming turn, the revision bumps, and no
    // on_the_clock ever fires for that turn — the owner sits at the board with
    // no alert, which is the one thing this feature exists to prevent.
    const { state } = advance(base(), 8); // owner (team 1) picks overall 3 and 10
    expect(state.picks).toHaveLength(8);

    const ledger = Array.from({ length: 8 }, (_, i) =>
      pick(0, i === 7 ? 9999 : 3000 + i, { overallPickNumber: i + 1 }),
    );
    const corrected = reconcile(state, obs({ ledger }));

    expect(corrected.state.revision).toBe(1);
    const deck = corrected.events.filter((e) => e.kind === "on_deck" && e.overall === 10);
    const clock = corrected.events.filter((e) => e.kind === "on_the_clock" && e.overall === 10);
    expect(deck, "on_deck must re-fire under the new revision").toHaveLength(1);
    expect(clock, "on_the_clock must re-fire under the new revision").toHaveLength(1);
    expect(deck[0]!.revision).toBe(1);
    expect(clock[0]!.revision).toBe(1);
    // Still in order, still exactly once each at that revision.
    expect(corrected.events.indexOf(deck[0]!)).toBeLessThan(corrected.events.indexOf(clock[0]!));
  });

  it("does NOT re-fire a turn the draft has already passed", () => {
    // The other half: re-announcing a turn that already happened would be
    // just as wrong as missing one.
    const { state } = advance(base(), 8);
    const ledger = Array.from({ length: 8 }, (_, i) =>
      pick(0, i === 7 ? 9999 : 3000 + i, { overallPickNumber: i + 1 }),
    );
    const corrected = reconcile(state, obs({ ledger }));
    expect(corrected.events.filter((e) => e.kind === "on_the_clock" && e.overall === 3)).toHaveLength(0);
  });

  it("does not duplicate picks when a ledger carries NO ordinals", () => {
    // feed.ts sets overallPickNumber: undefined for any non-integer, so one
    // shape change upstream reaches this path. It used to append every row
    // again: two streamed picks plus a restating ledger produced four.
    let s = base();
    s = reconcile(s, obs({ picks: [pick(0, 100), pick(0, 101)] })).state;
    const r = reconcile(s, obs({ ledger: [pick(0, 100), pick(0, 101)] }));
    expect(r.state.picks).toHaveLength(2);
    expect(r.state.picks.map((p) => p.playerId)).toEqual([100, 101]);
  });

  it("places a pick recovered LATE at its observed position, not at the end", () => {
    // A second tab supplying a frame the first tab dropped. Appending by
    // arrival made a first-round player the last pick of the draft.
    const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
    let s = base();
    for (const [pid, n] of [
      [1001, 1],
      [1002, 2],
      [1004, 4],
      [1005, 5],
    ] as [number, number][]) {
      s = reconcile(s, obs({ picks: [pick(0, pid, { observedAt: at(n) })] })).state;
    }
    const r = reconcile(s, obs({ picks: [pick(0, 1003, { observedAt: at(3) })] }));
    expect(r.state.picks.map((p) => p.playerId)).toEqual([1001, 1002, 1003, 1004, 1005]);
  });
});
