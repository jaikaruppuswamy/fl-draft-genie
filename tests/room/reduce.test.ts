// 007 T007 / T035 — the frame contract, and the retained-state bound.
//
// Three of these exist because 005's contracts/api.md says each prevents a
// specific draft-night failure, and the reducer must not undo what
// `draftSocket.ts` already gets right:
//
//   * duplicates are FREE — treating one as a gap produces a resync storm at
//     exactly the moment the draft is busiest;
//   * a mismatched EPOCH is a reset, not an error — carrying a stale cursor
//     across a rebuild silently skips a reconstructed draft;
//   * only a true FORWARD GAP resyncs.

import { describe, expect, it } from "vitest";
import { reduce, initialState } from "../../web/src/lib/draftRoom";
import { armed, eventFrame, pickFrame, snapshotFrame, EPOCH } from "./helpers";

const AT = 1_000;

describe("snapshots are authoritative", () => {
  it("adopts epoch and cursor wholesale", () => {
    const { state } = reduce(
      initialState(),
      { kind: "frame", frame: snapshotFrame({ seq: 42, state: { picks: [], revision: 7 } }) },
      AT,
    );
    expect(state.epoch).toBe(EPOCH);
    expect(state.cursor).toBe(42);
    expect(state.revision).toBe(7);
  });

  it("requests a recommendation, because a fresh snapshot invalidates any held board", () => {
    const { effects } = reduce(initialState(), { kind: "frame", frame: snapshotFrame() }, AT);
    expect(effects).toEqual([{ kind: "fetchRecommendation" }]);
  });

  it("discards a previously held recommendation", () => {
    const start = armed({ recommendation: { revision: 1 } as never, recommendationRevision: 1 });
    const { state } = reduce(start, { kind: "frame", frame: snapshotFrame({ seq: 5 }) }, AT);
    expect(state.recommendation).toBeNull();
    expect(state.recommendationRevision).toBeNull();
  });

  it("orders picks by overall regardless of arrival order", () => {
    const { state } = reduce(
      initialState(),
      {
        kind: "frame",
        frame: snapshotFrame({
          state: {
            revision: 1,
            picks: [
              { overall: 3, teamId: 3, playerId: 300 },
              { overall: 1, teamId: 1, playerId: 100 },
            ],
          },
        }),
      },
      AT,
    );
    expect(state.picks.map((p) => p.overall)).toEqual([1, 3]);
  });
});

describe("duplicates are free", () => {
  it("a frame at the cursor changes nothing and emits nothing", () => {
    const start = armed({ cursor: 5 });
    const { state, effects } = reduce(start, { kind: "frame", frame: pickFrame(5, 1, 1, 100) }, AT);
    expect(state).toEqual(start);
    expect(effects).toEqual([]);
  });

  it("a frame BELOW the cursor changes nothing and emits nothing", () => {
    const start = armed({ cursor: 5 });
    const { state, effects } = reduce(start, { kind: "frame", frame: pickFrame(3, 1, 1, 100) }, AT);
    expect(state).toEqual(start);
    expect(effects).toEqual([]);
  });

  it("re-delivering the same pick does not place it twice", () => {
    let state = armed({ cursor: 0 });
    state = reduce(state, { kind: "frame", frame: pickFrame(1, 1, 5, 100) }, AT).state;
    // A different seq carrying the same player — the shape a re-send takes.
    state = reduce(state, { kind: "frame", frame: pickFrame(2, 1, 5, 100) }, AT).state;
    expect(state.picks).toHaveLength(1);
  });
});

describe("gaps and epochs", () => {
  it("requests a snapshot on a true FORWARD gap", () => {
    const { effects } = reduce(armed({ cursor: 5 }), { kind: "frame", frame: pickFrame(9, 1, 1, 100) }, AT);
    expect(effects).toEqual([{ kind: "fetchSnapshot" }]);
  });

  it("does NOT resync for the very next seq", () => {
    const { effects } = reduce(armed({ cursor: 5 }), { kind: "frame", frame: pickFrame(6, 1, 1, 100) }, AT);
    expect(effects).toEqual([{ kind: "fetchRecommendation" }]);
  });

  it("treats an epoch change as a RESET and re-reads", () => {
    const start = armed({ cursor: 5, picks: [{ overall: 1, teamId: 1, playerId: 100 }] });
    const { state, effects } = reduce(
      start,
      { kind: "frame", frame: eventFrame(6, { kind: "pick_made", overall: 2, teamId: 2, playerId: 200 }, "epoch-2") },
      AT,
    );
    expect(effects).toEqual([{ kind: "fetchSnapshot" }]);
    expect(state.epoch).toBeNull();
    expect(state.cursor).toBe(-1);
  });

  it("a REVISION bump discards the held board and re-reads", () => {
    const start = armed({ cursor: 5, revision: 1, recommendation: { revision: 1 } as never });
    const { state, effects } = reduce(
      start,
      { kind: "frame", frame: eventFrame(6, { kind: "pick_made", revision: 2, overall: 1, teamId: 1, playerId: 1 }) },
      AT,
    );
    expect(state.revision).toBe(2);
    expect(state.recommendation).toBeNull();
    expect(effects).toEqual([{ kind: "fetchSnapshot" }]);
  });
});

describe("turn state drives the visuals, not the fetching (FR-004)", () => {
  it("on_deck sets the state and emits NO effect", () => {
    const { state, effects } = reduce(
      armed({ cursor: 5 }),
      { kind: "frame", frame: eventFrame(6, { kind: "on_deck", picksUntil: 2 }) },
      AT,
    );
    expect(state.myTurnState).toBe("on_deck");
    // Refreshing per pick already keeps the board current — this is what
    // dissolves the snake turnaround as a special case.
    expect(effects).toEqual([]);
  });

  it("on_the_clock sets the state and emits NO effect", () => {
    const { state, effects } = reduce(
      armed({ cursor: 5 }),
      { kind: "frame", frame: eventFrame(6, { kind: "on_the_clock", teamId: 1 }) },
      AT,
    );
    expect(state.myTurnState).toBe("on_the_clock");
    expect(effects).toEqual([]);
  });

  it("a gap of one still reads as on deck — the turnaround case", () => {
    const { state } = reduce(
      armed({ cursor: 5 }),
      { kind: "frame", frame: eventFrame(6, { kind: "on_deck", picksUntil: 1 }) },
      AT,
    );
    expect(state.myTurnState).toBe("on_deck");
  });

  it("an unknown distance is idle, never on deck", () => {
    expect(armed().myTurnState).toBe("idle");
  });
});

describe("SC-008 — retained state grows with PICKS, not FRAMES", () => {
  it("stays bounded across far more frames than a draft contains", () => {
    // The old wording was "usable for a full-length draft without degradation",
    // which named no measurable thing. This is the measurable form: raw frames
    // are applied and discarded, so only materialised picks are retained.
    let state = armed({ cursor: 0, totalPicks: 0 });
    let seq = 1;
    for (let i = 0; i < 500; i++) {
      // Alternate real picks with duplicates and re-sends — the shapes that
      // would accumulate if frames were retained.
      state = reduce(state, { kind: "frame", frame: pickFrame(seq, i + 1, (i % 6) + 1, 1000 + i) }, AT).state;
      seq++;
      state = reduce(state, { kind: "frame", frame: pickFrame(seq - 1, i + 1, (i % 6) + 1, 1000 + i) }, AT).state;
    }
    expect(state.picks).toHaveLength(500);
    // No other collection grew: the state object holds picks and scalars only.
    const arrays = Object.values(state).filter((v) => Array.isArray(v)) as unknown[][];
    for (const arr of arrays) {
      expect(arr.length).toBeLessThanOrEqual(500);
    }
  });

  it("holds no reference to raw frames", () => {
    let state = armed({ cursor: 0 });
    state = reduce(state, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT).state;
    const serialised = JSON.stringify(state);
    expect(serialised).not.toContain('"type":"event"');
    expect(serialised).not.toContain('"seq"');
  });
});

describe("purity, as a property of the signature", () => {
  it("takes the time as a parameter — three arguments, no clock", () => {
    expect(reduce.length).toBe(3);
  });

  it("does not mutate the state it is given", () => {
    const start = armed({ cursor: 0 });
    const before = JSON.stringify(start);
    reduce(start, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT);
    expect(JSON.stringify(start)).toBe(before);
  });

  it("is deterministic across repeated application", () => {
    const start = armed({ cursor: 0 });
    const a = reduce(start, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT);
    const b = reduce(start, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("the owner's identity comes from the league, not the stream", () => {
  // 005's snapshot never carries `myTeamId`. Without an explicit input it stays
  // null and THREE things fail silently: the owner's column is not highlighted,
  // `rosterView()` filters their picks to nothing, and the bye grid is empty.
  // Nothing errors — the screen just omits the owner from their own draft.
  //
  // Found by looking at the rendered page, not by any test.

  it("is null until told", () => {
    expect(initialState().myTeamId).toBeNull();
  });

  it("is adopted from the identity input", () => {
    const { state } = reduce(initialState(), { kind: "identity", myTeamId: 7 }, AT);
    expect(state.myTeamId).toBe(7);
  });

  it("emits no effect — it is not a reason to refetch", () => {
    expect(reduce(initialState(), { kind: "identity", myTeamId: 7 }, AT).effects).toEqual([]);
  });

  it("survives a snapshot, which does not carry it", () => {
    let state = reduce(initialState(), { kind: "identity", myTeamId: 7 }, AT).state;
    state = reduce(state, { kind: "frame", frame: snapshotFrame({ seq: 3 }) }, AT).state;
    expect(state.myTeamId).toBe(7);
  });

  it("accepts null for a league with no identified team", () => {
    const start = reduce(initialState(), { kind: "identity", myTeamId: 7 }, AT).state;
    expect(reduce(start, { kind: "identity", myTeamId: null }, AT).state.myTeamId).toBeNull();
  });
});
