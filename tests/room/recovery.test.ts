// 007 T036–T038 — SC-004 and SC-005: reload, gap, epoch change.
//
// Constitution V: "a live draft cannot be paused or replayed". The screen has
// to come back by itself, and the three ways it can fail to are each specific:
//
//   reload  — cold start mid-draft must restore everything (SC-004)
//   gap     — frames missed while disconnected must arrive exactly once (SC-005)
//   epoch   — a rebuild must DISCARD, never merge; carrying a stale cursor
//             across one silently skips a reconstructed draft

import { describe, expect, it } from "vitest";
import { reduce, initialState, type RoomState } from "../../web/src/lib/draftRoom";
import { EPOCH, armed, pickFrame, snapshotFrame } from "./helpers";

const AT = 5_000;

/** A draft mid-flight: 20 picks made. */
function midDraft(): { overall: number; teamId: number; playerId: number }[] {
  return Array.from({ length: 20 }, (_, i) => ({
    overall: i + 1,
    teamId: (i % 6) + 1,
    playerId: 1000 + i,
  }));
}

describe("SC-004 — reload mid-draft", () => {
  it("restores every pick exactly once from a cold start", () => {
    const picks = midDraft();
    const { state } = reduce(
      initialState(), // cold: nothing retained across the reload
      { kind: "frame", frame: snapshotFrame({ seq: 20, state: { picks, revision: 3, totalPicks: 72 } }) },
      AT,
    );
    expect(state.picks).toHaveLength(20);
    expect(state.picks.map((p) => p.overall)).toEqual(picks.map((p) => p.overall));
    expect(new Set(state.picks.map((p) => p.playerId)).size).toBe(20);
    expect(state.revision).toBe(3);
  });

  it("requires no action from the owner — the snapshot alone is enough", () => {
    const { state, effects } = reduce(
      initialState(),
      { kind: "frame", frame: snapshotFrame({ seq: 20, state: { picks: midDraft(), revision: 3 } }) },
      AT,
    );
    // One fetch for a fresh recommendation, and nothing else asked of anyone.
    expect(effects).toEqual([{ kind: "fetchRecommendation" }]);
    expect(state.phase).toBe("live");
  });

  it("resumes applying events immediately after the reload", () => {
    let state = reduce(
      initialState(),
      { kind: "frame", frame: snapshotFrame({ seq: 20, state: { picks: midDraft(), revision: 3 } }) },
      AT,
    ).state;
    state = reduce(state, { kind: "frame", frame: pickFrame(21, 21, 3, 2000) }, AT).state;
    expect(state.picks).toHaveLength(21);
  });
});

describe("SC-005 — a connection gap", () => {
  it("recovers the missed picks exactly once", () => {
    // Frames 6..10 never arrive; the socket reconnects and a snapshot lands.
    let state: RoomState = armed({ cursor: 5, picks: midDraft().slice(0, 5) });
    const gapFrame = reduce(state, { kind: "frame", frame: pickFrame(11, 11, 5, 1010) }, AT);
    // A forward gap asks for the truth rather than guessing at it.
    expect(gapFrame.effects).toEqual([{ kind: "fetchSnapshot" }]);
    state = gapFrame.state;

    state = reduce(
      state,
      { kind: "frame", frame: snapshotFrame({ seq: 11, state: { picks: midDraft().slice(0, 11), revision: 1 } }) },
      AT,
    ).state;
    expect(state.picks).toHaveLength(11);
    expect(new Set(state.picks.map((p) => p.playerId)).size).toBe(11);
  });

  it("a duplicate arriving after the resync changes nothing", () => {
    const state: RoomState = reduce(
      armed(),
      { kind: "frame", frame: snapshotFrame({ seq: 11, state: { picks: midDraft().slice(0, 11), revision: 1 } }) },
      AT,
    ).state;
    const before = JSON.stringify(state);
    const step = reduce(state, { kind: "frame", frame: pickFrame(11, 11, 5, 1010) }, AT);
    expect(JSON.stringify(step.state)).toBe(before);
    expect(step.effects).toEqual([]);
  });

  it("does not double-place a pick that both the snapshot and an event carry", () => {
    // The realistic race: the snapshot lands, and a buffered event for a pick
    // already in it arrives right after.
    let state = reduce(
      armed(),
      { kind: "frame", frame: snapshotFrame({ seq: 10, state: { picks: midDraft().slice(0, 10), revision: 1 } }) },
      AT,
    ).state;
    state = reduce(state, { kind: "frame", frame: pickFrame(11, 10, 4, 1009) }, AT).state;
    expect(state.picks).toHaveLength(10);
  });
});

describe("an epoch change is a RESET, not a merge", () => {
  it("discards local state and re-reads", () => {
    const state = armed({ cursor: 30, picks: midDraft() });
    const { state: after, effects } = reduce(
      state,
      {
        kind: "frame",
        frame: { type: "event", epoch: "epoch-2", seq: 31, event: { kind: "pick_made", overall: 21, teamId: 1, playerId: 9 } } as never,
      },
      AT,
    );
    expect(effects).toEqual([{ kind: "fetchSnapshot" }]);
    expect(after.epoch).toBeNull();
    expect(after.cursor).toBe(-1);
  });

  it("adopts the rebuilt draft wholesale from the new snapshot", () => {
    // The failure this prevents: merging a stale cursor into a reconstructed
    // draft, which silently skips whatever the rebuild changed.
    let state = armed({ cursor: 30, picks: midDraft() });
    state = reduce(
      state,
      { kind: "frame", frame: { type: "event", epoch: "epoch-2", seq: 31, event: {} } as never },
      AT,
    ).state;
    const rebuilt = [{ overall: 1, teamId: 6, playerId: 7777 }];
    state = reduce(
      state,
      { kind: "frame", frame: snapshotFrame({ epoch: "epoch-2", seq: 1, state: { picks: rebuilt, revision: 9 } }) },
      AT,
    ).state;
    expect(state.epoch).toBe("epoch-2");
    expect(state.picks).toEqual(rebuilt);
    expect(state.revision).toBe(9);
  });

  it("keeps the original epoch when frames agree", () => {
    const { state } = reduce(armed({ cursor: 5 }), { kind: "frame", frame: pickFrame(6, 6, 2, 500) }, AT);
    expect(state.epoch).toBe(EPOCH);
  });
});
