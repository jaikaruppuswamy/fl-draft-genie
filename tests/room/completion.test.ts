// 007 T039/T040 — SC-011: two routes to "complete", each proven alone.
//
// THIS IS THE LEAST-EVIDENCED PATH IN THE WHOLE PRODUCT.
//
// The completion signal has NEVER FIRED IN PRODUCTION. `draft_archives` holds
// zero rows, because the draft length was 0 during the only live test, which
// made completion unreachable. And the pick-count route depends on that same
// draft length — which has itself been wrong.
//
// Two untested routes are not twice the confidence. But they fail DIFFERENTLY:
// a missing event and a wrong total do not coincide. So the screen concludes
// from either, each is tested in isolation here, and a DISAGREEMENT is recorded
// rather than resolved — because whichever fires alone on the next real draft
// is the first evidence anyone will have about which to trust.

import { describe, expect, it } from "vitest";
import { reduce, type RoomState } from "../../web/src/lib/draftRoom";
import { armed, eventFrame, pickFrame, snapshotFrame } from "./helpers";

const AT = 9_000;
const TOTAL = 12;

/** Deliver every pick of a short draft, without any completion signal. */
function runToLastPick(totalPicks = TOTAL): RoomState {
  let state = armed({ cursor: 0, totalPicks, myTeamId: 1 });
  for (let i = 1; i <= totalPicks; i++) {
    state = reduce(state, { kind: "frame", frame: pickFrame(i, i, ((i - 1) % 6) + 1, 1000 + i) }, AT).state;
  }
  return state;
}

describe("route 1 — the completion SIGNAL alone", () => {
  it("completes even when the pick count says otherwise", () => {
    // The draft length is wrong (too high) and the picks never reach it. Only
    // the signal can conclude here — and if the screen waited for the count it
    // would sit "live" forever after the last pick.
    let state = armed({ cursor: 0, totalPicks: 999 });
    state = reduce(state, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT).state;
    state = reduce(
      state,
      { kind: "frame", frame: eventFrame(2, { kind: "draft_complete", totalPicks: 999 }) },
      AT,
    ).state;

    expect(state.phase).toBe("complete");
    expect(state.completion?.by).toBe("signal");
    expect(state.completion?.divergent).toBe(true);
  });

  it("records when it concluded", () => {
    let state = armed({ cursor: 0, totalPicks: 999 });
    state = reduce(state, { kind: "frame", frame: eventFrame(1, { kind: "draft_complete" }) }, AT).state;
    expect(state.completion?.at).toBe(AT);
  });
});

describe("route 2 — the observed PICK COUNT alone", () => {
  it("completes with no signal ever arriving", () => {
    // The route that matters most given the evidence: the signal has never
    // fired in production, so this may be the only one that ever runs.
    const state = runToLastPick();
    expect(state.phase).toBe("complete");
    expect(state.completion?.by).toBe("pick_count");
    expect(state.completion?.divergent).toBe(true);
  });

  it("does NOT complete one pick early", () => {
    let state = armed({ cursor: 0, totalPicks: TOTAL });
    for (let i = 1; i < TOTAL; i++) {
      state = reduce(state, { kind: "frame", frame: pickFrame(i, i, 1, 1000 + i) }, AT).state;
    }
    expect(state.phase).toBe("live");
    expect(state.completion).toBeNull();
  });

  it("never completes while the draft length is UNKNOWN", () => {
    // `totalPicks: 0` means "not established", never a total. 005 was bitten by
    // exactly this, and it made completion unreachable in production.
    let state = armed({ cursor: 0, totalPicks: 0 });
    for (let i = 1; i <= 30; i++) {
      state = reduce(state, { kind: "frame", frame: pickFrame(i, i, 1, 1000 + i) }, AT).state;
    }
    expect(state.phase).toBe("live");
    expect(state.completion).toBeNull();
  });
});

describe("both routes agreeing", () => {
  it("records `both` and no divergence", () => {
    let state = runToLastPick();
    // Already complete by count; the signal then confirms it via a snapshot.
    state = reduce(
      state,
      {
        kind: "frame",
        frame: snapshotFrame({
          seq: 100,
          state: {
            revision: 1,
            totalPicks: TOTAL,
            complete: true,
            picks: Array.from({ length: TOTAL }, (_, i) => ({
              overall: i + 1,
              teamId: ((i % 6) + 1),
              playerId: 1000 + i + 1,
            })),
          },
        }),
      },
      AT,
    ).state;
    expect(state.completion?.by).toBe("both");
    expect(state.completion?.divergent).toBe(false);
  });
});

describe("FR-022b — a disagreement is SURFACED, not resolved", () => {
  it("still completes, and records that the routes disagreed", () => {
    const signalOnly = (() => {
      let s = armed({ cursor: 0, totalPicks: 999 });
      return reduce(s, { kind: "frame", frame: eventFrame(1, { kind: "draft_complete" }) }, AT).state;
    })();
    const countOnly = runToLastPick();

    for (const state of [signalOnly, countOnly]) {
      expect(state.phase).toBe("complete");
      expect(state.completion?.divergent).toBe(true);
    }
    // …and they name DIFFERENT routes, which is the information worth keeping.
    expect(signalOnly.completion?.by).not.toBe(countOnly.completion?.by);
  });

  it("does not silently pick a winner", () => {
    // The failure this prevents: collapsing both into a boolean, which would
    // throw away the only evidence the next real draft will produce about
    // which route actually works.
    const state = runToLastPick();
    expect(state.completion).not.toBeNull();
    expect(typeof state.completion!.by).toBe("string");
    expect(state.completion!.by).not.toBe("both");
  });
});

describe("after completion", () => {
  it("stops requesting recommendations", () => {
    // The draft is over; there is nothing left to advise on, and continuing to
    // fetch would be noise for as long as the tab stays open.
    let state = armed({ cursor: 0, totalPicks: 2 });
    state = reduce(state, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT).state;
    const last = reduce(state, { kind: "frame", frame: pickFrame(2, 2, 2, 200) }, AT);
    expect(last.state.phase).toBe("complete");
    expect(last.effects).toEqual([]);
  });
});
