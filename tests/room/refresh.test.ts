// 007 T010/T011 — the refresh policy (FR-003, research §3).
//
// FR-003 says refresh on every pick. Taken literally that is one request per
// pick — and measured autodraft runs produced ~1 pick per SECOND, so a literal
// reading means 60 requests a minute at the busiest moment of the draft.
//
// The policy: ONE REQUEST IN FLIGHT, ONE TRAILING. Whatever lands while a
// request is outstanding collapses into exactly one further fetch. The
// guarantee survives — the board is never more than one round trip behind — but
// the cost is bounded by round-trip time rather than by pick rate.
//
// The property worth stating: it degrades in the RIGHT direction. A slow server
// produces FEWER requests, never a queue of them.

import { describe, expect, it } from "vitest";
import { reduce } from "../../web/src/lib/draftRoom";
import { armed, board, pickFrame } from "./helpers";

const AT = 1_000;

describe("one in flight, one trailing", () => {
  it("fetches immediately when nothing is outstanding", () => {
    const { state, effects } = reduce(armed({ cursor: 0 }), { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT);
    expect(effects).toEqual([{ kind: "fetchRecommendation" }]);
    expect(state.inFlight).toBe(true);
    expect(state.dirty).toBe(false);
  });

  it("emits NOTHING for a pick that lands while a request is outstanding", () => {
    const busy = armed({ cursor: 1, inFlight: true });
    const { state, effects } = reduce(busy, { kind: "frame", frame: pickFrame(2, 2, 2, 200) }, AT);
    expect(effects).toEqual([]);
    expect(state.dirty).toBe(true);
  });

  it("fires EXACTLY ONE trailing fetch, however many picks were buffered", () => {
    // The failure this prevents: a dozen picks during one autodraft burst
    // producing a dozen queued requests when the first returns.
    let state = armed({ cursor: 0 });
    state = reduce(state, { kind: "frame", frame: pickFrame(1, 1, 1, 100) }, AT).state; // fetch fires
    for (let i = 2; i <= 12; i++) {
      const step = reduce(state, { kind: "frame", frame: pickFrame(i, i, 1, 100 + i) }, AT);
      expect(step.effects, `pick ${i} must not fetch`).toEqual([]);
      state = step.state;
    }
    const done = reduce(state, { kind: "recommendation", board: board(0), forRevision: 0 }, AT);
    expect(done.effects).toEqual([{ kind: "fetchRecommendation" }]);
    expect(done.state.dirty).toBe(false);
    expect(done.state.inFlight).toBe(true);
  });

  it("emits nothing on return when no pick landed meanwhile", () => {
    const state = armed({ cursor: 1, inFlight: true, dirty: false });
    const { effects, state: after } = reduce(state, { kind: "recommendation", board: board(0), forRevision: 0 }, AT);
    expect(effects).toEqual([]);
    expect(after.inFlight).toBe(false);
  });

  it("a slower server produces FEWER requests, not more", () => {
    // The direction that matters. Ten picks during one slow round trip cost
    // two requests total; ten picks with instant returns cost ten.
    const slow = (() => {
      let s = armed({ cursor: 0 });
      let fetches = 0;
      for (let i = 1; i <= 10; i++) {
        const step = reduce(s, { kind: "frame", frame: pickFrame(i, i, 1, 100 + i) }, AT);
        fetches += step.effects.length;
        s = step.state;
      }
      fetches += reduce(s, { kind: "recommendation", board: board(0), forRevision: 0 }, AT).effects.length;
      return fetches;
    })();

    const fast = (() => {
      let s = armed({ cursor: 0 });
      let fetches = 0;
      for (let i = 1; i <= 10; i++) {
        const step = reduce(s, { kind: "frame", frame: pickFrame(i, i, 1, 100 + i) }, AT);
        fetches += step.effects.length;
        s = reduce(step.state, { kind: "recommendation", board: board(0), forRevision: 0 }, AT).state;
      }
      return fetches;
    })();

    expect(slow).toBe(2);
    expect(fast).toBe(10);
    expect(slow).toBeLessThan(fast);
  });
});

describe("a stale response is discarded, not rendered (FR-016)", () => {
  it("keeps a board whose revision still matches", () => {
    const state = armed({ revision: 3, inFlight: true });
    const { state: after } = reduce(state, { kind: "recommendation", board: board(3), forRevision: 3 }, AT);
    expect(after.recommendation).not.toBeNull();
    expect(after.recommendationRevision).toBe(3);
  });

  it("DISCARDS a board computed for a superseded revision", () => {
    // 005 bumps its revision on a correction and replays the affected turns.
    // Rendering the old board would show advice for a draft that has moved on.
    const state = armed({ revision: 4, inFlight: true });
    const { state: after } = reduce(state, { kind: "recommendation", board: board(3), forRevision: 3 }, AT);
    expect(after.recommendation).toBeNull();
    expect(after.recommendationRevision).toBeNull();
  });

  it("clears inFlight even when the response is discarded", () => {
    // Otherwise one stale response wedges the screen forever.
    const state = armed({ revision: 4, inFlight: true });
    expect(reduce(state, { kind: "recommendation", board: board(3), forRevision: 3 }, AT).state.inFlight).toBe(
      false,
    );
  });

  it("clears inFlight when the request FAILED", () => {
    const state = armed({ revision: 4, inFlight: true });
    const { state: after } = reduce(state, { kind: "recommendation", board: null, forRevision: 4 }, AT);
    expect(after.inFlight).toBe(false);
    expect(after.recommendation).toBeNull();
  });

  it("still fires the trailing fetch after a discarded response", () => {
    const state = armed({ revision: 4, inFlight: true, dirty: true });
    const { effects } = reduce(state, { kind: "recommendation", board: board(3), forRevision: 3 }, AT);
    expect(effects).toEqual([{ kind: "fetchRecommendation" }]);
  });
});

describe("a withheld board is an answer, not a failure (FR-014)", () => {
  it("is stored and surfaced rather than retried", () => {
    // 006 returns 200 with empty entries and a reason. The question was
    // answered; the answer is "I will not guess". Retrying it as an error
    // would hammer the endpoint during exactly the outage it is reporting.
    const withheld = board(0, {
      withheld: { reason: "not_receiving", detail: "No tap heartbeat for 61s" },
      entries: [],
      shortlist: [],
    });
    const { state, effects } = reduce(
      armed({ inFlight: true }),
      { kind: "recommendation", board: withheld, forRevision: 0 },
      AT,
    );
    expect(state.recommendation).not.toBeNull();
    expect((state.recommendation as unknown as { withheld: unknown }).withheld).not.toBeNull();
    expect(effects).toEqual([]);
  });
});

describe("reachability is separate from picks arriving", () => {
  it("records it without touching the draft state", () => {
    // Two different failures with two different remedies — "wait" versus "go
    // check the tap's tab". During a live draft a wrong diagnosis costs a pick.
    const start = armed({ cursor: 3, picks: [{ overall: 1, teamId: 1, playerId: 1 }] });
    const { state } = reduce(start, { kind: "reachability", state: "polling" }, AT);
    expect(state.reachability).toBe("polling");
    expect(state.picks).toEqual(start.picks);
    expect(state.withholding).toBeNull();
  });
});

describe("the room asks on OPEN (the first-turn gap)", () => {
  // Found by opening the page: the rail said "no recommendation yet" while the
  // endpoint was returning a perfectly good board. Nothing triggered a fetch —
  // snapshots and picks do, but before a session is armed neither exists.
  //
  // The replay harness's own comment already claimed "the screen requests on
  // load". It did not. That is the exact shape of failure this project keeps
  // hitting: documented, believed, never implemented.

  it("fetches immediately when the room opens", () => {
    const { state, effects } = reduce(armed(), { kind: "opened" }, AT);
    expect(effects).toEqual([{ kind: "fetchRecommendation" }]);
    expect(state.inFlight).toBe(true);
  });

  it("covers the owner's FIRST turn, which has no earlier pick to pre-warm it", () => {
    // Pre-draft: no frames at all, and the first pick may be an hour away.
    const { effects } = reduce(armed({ picks: [], phase: "pre_draft" }), { kind: "opened" }, AT);
    expect(effects).toHaveLength(1);
  });

  it("respects the in-flight rule rather than racing an outstanding request", () => {
    const { effects, state } = reduce(armed({ inFlight: true }), { kind: "opened" }, AT);
    expect(effects).toEqual([]);
    expect(state.dirty).toBe(true);
  });
});
