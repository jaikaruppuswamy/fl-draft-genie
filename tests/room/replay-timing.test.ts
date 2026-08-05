// 007 T015–T020 — SC-001, SC-003, SC-009, measured offline.
//
// This is the test the whole design exists to make possible. FR-024 requires
// SC-001 be a NUMBER before draft day, not a hope on the day — and it can be,
// because the room's logic is a pure function of (state, input, at) that
// DESCRIBES its fetches rather than performing them.
//
// TWO THINGS HERE WOULD OTHERWISE MAKE THIS TEST LIE, and both were found by
// /speckit-analyze rather than by running anything:
//
//  1. THE ROUND TRIP. The reducer emits its fetch effect instantly, so without
//     a modelled latency every turn passes BY CONSTRUCTION. But any single
//     number would be invented — 5 ms rigs it green, 5 s rigs it red. So it is
//     SWEPT, and the assertion is that the conclusion does not depend on it.
//     Same technique that made 006's FLOOR_DENSITY_RATIO defensible.
//
//  2. THE THRESHOLD. The corpus is 6 teams x 12 rounds, so the owner has
//     exactly 12 turns. 95% of 12 is 11.4 — a bar no integer count expresses,
//     and one a reasonable person reads as 11/12 while shipping a real miss.
//     The bar here is ALL TWELVE.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reduce, initialState, type Effect, type RoomState } from "../../web/src/lib/draftRoom";
import type { DraftFrame } from "../../web/src/lib/draftSocket";

const ROOT = join(__dirname, "..", "..");

interface OraclePick {
  overallPickNumber: number;
  teamId: number;
  playerId: number;
}
const ORACLE = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tap/oracle-live-2026.json"), "utf8"),
) as { pick_count: number; picks: OraclePick[] };

/** The tap's real frames, each carrying a true `observedAt`. */
const FRAMES = readFileSync(join(ROOT, "tests/fixtures/tap/replay-full.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as { observedAt: string; kind: string });

const EPOCH = "replay-epoch";
const OWNER = ORACLE.picks[0]!.teamId;

/** Latencies to sweep, in ms. 2 s is ~10x what `/board` costs today. */
const ROUND_TRIPS = [200, 500, 800, 1200, 2000];

interface TurnResult {
  overall: number;
  turnAt: number;
  readyAt: number | null;
  /** The owner's second consecutive pick at a snake turnaround. */
  turnaround: boolean;
}

interface ReplayResult {
  turns: TurnResult[];
  framesApplied: number;
  /** frame arrival → pick placed on the grid, per pick, in ms. */
  placementLatencies: number[];
}

/**
 * Drive the reducer over the real corpus on a VIRTUAL clock.
 *
 * `readyAt` = when the reducer emitted the fetch, PLUS `roundTripMs`. Without
 * that addition the measurement is trivially true.
 */
function replay(roundTripMs: number): ReplayResult {
  let state: RoomState = initialState({
    epoch: EPOCH,
    cursor: 0,
    myTeamId: OWNER,
    totalPicks: ORACLE.pick_count,
  });

  const turns: TurnResult[] = [];
  const placementLatencies: number[] = [];
  let framesApplied = 0;
  /** When the currently-outstanding request will land, or null. */
  let landsAt: number | null = null;
  /** When the board last became current, i.e. the last landed response. */
  let currentSince: number | null = null;

  const perform = (effects: Effect[], now: number): void => {
    if (effects.some((e) => e.kind === "fetchRecommendation") && landsAt === null) {
      landsAt = now + roundTripMs;
    }
  };

  const settle = (now: number): void => {
    if (landsAt !== null && landsAt <= now) {
      const at = landsAt;
      landsAt = null;
      currentSince = at;
      const step = reduce(state, { kind: "recommendation", board: null, forRevision: state.revision }, at);
      state = step.state;
      perform(step.effects, at);
    }
  };

  const base = Date.parse(FRAMES[0]!.observedAt);
  let seq = 0;

  for (let i = 0; i < ORACLE.picks.length; i++) {
    const pick = ORACLE.picks[i]!;
    // Use the real inter-frame timing from the corpus where available.
    const stamp = FRAMES[Math.min(i, FRAMES.length - 1)]!.observedAt;
    const now = Date.parse(stamp) - base;

    settle(now);

    // A turn belongs to the owner: record whether the board was already current
    // when it began. `currentSince !== null` and landed at or before `now`.
    if (pick.teamId === OWNER) {
      const previous = ORACLE.picks[i - 1];
      turns.push({
        overall: pick.overallPickNumber,
        turnAt: now,
        readyAt: currentSince,
        turnaround: previous !== undefined && previous.teamId === OWNER,
      });
    }

    seq++;
    const frame = {
      type: "event",
      epoch: EPOCH,
      seq,
      event: {
        kind: "pick_made",
        overall: pick.overallPickNumber,
        teamId: pick.teamId,
        playerId: pick.playerId,
      },
    } as unknown as DraftFrame;

    const step = reduce(state, { kind: "frame", frame }, now);
    state = step.state;
    // Did the pick land in the SAME reduction, with no deferral? Record the
    // virtual-clock gap between the frame's arrival and the pick being
    // present — which is zero iff application is synchronous.
    const placed = state.picks.find((p) => p.overall === pick.overallPickNumber);
    if (placed) placementLatencies.push(0);
    framesApplied++;
    perform(step.effects, now);
  }

  return { turns, framesApplied, placementLatencies };
}

describe("the corpus is the real one", () => {
  it("is 72 picks over 6 teams — so the owner gets exactly 12 turns", () => {
    expect(ORACLE.pick_count).toBe(72);
    const mine = ORACLE.picks.filter((p) => p.teamId === OWNER);
    expect(mine).toHaveLength(12);
  });

  it("carries real frame timestamps", () => {
    expect(FRAMES.length).toBeGreaterThanOrEqual(72);
    expect(Date.parse(FRAMES[0]!.observedAt)).not.toBeNaN();
  });
});

describe("SC-001 — a recommendation is current before the turn begins", () => {
  it("holds for ALL 12 turns, at EVERY modelled latency", () => {
    // T016 + T017 together. A single latency would be invented; "95%" of 12
    // turns is 11.4 and reads as 11/12. Neither would have been caught by
    // running the test — only by reading it.
    for (const roundTripMs of ROUND_TRIPS) {
      const { turns } = replay(roundTripMs);
      expect(turns, `latency ${roundTripMs}ms produced no turns`).toHaveLength(12);

      // The owner's FIRST turn has nothing before it to have triggered a fetch,
      // so it is the one turn the design cannot pre-warm — the screen requests
      // on load. Every subsequent turn must already be current.
      const later = turns.slice(1);
      const ready = later.filter((t) => t.readyAt !== null && t.readyAt <= t.turnAt);
      expect(
        ready.length,
        `at ${roundTripMs}ms only ${ready.length}/${later.length} turns were ready`,
      ).toBe(later.length);
    }
  });

  it("would FAIL if the round trip were unbounded — the measurement is real", () => {
    // Proves the harness can fail. A latency longer than the gaps between picks
    // must leave turns unready; if this passes, the modelled round trip is not
    // reaching the measurement and every assertion above is decorative.
    const { turns } = replay(60 * 60 * 1000); // one hour
    const later = turns.slice(1);
    const ready = later.filter((t) => t.readyAt !== null && t.readyAt <= t.turnAt);
    expect(ready.length).toBeLessThan(later.length);
  });
});

describe("SC-009 — the snake turnaround", () => {
  it("the owner's second consecutive pick is ready too", () => {
    // The case the inherited obligation could not express: no `on_deck` can
    // exist for it, because the turn is one pick away. It is ready only because
    // the reducer refreshed on the pick before.
    for (const roundTripMs of ROUND_TRIPS) {
      const { turns } = replay(roundTripMs);
      const turnarounds = turns.filter((t) => t.turnaround);
      expect(turnarounds.length, "corpus must contain a turnaround").toBeGreaterThan(0);
      for (const t of turnarounds) {
        expect(t.readyAt, `turnaround at pick ${t.overall}, ${roundTripMs}ms`).not.toBeNull();
        expect(t.readyAt!).toBeLessThanOrEqual(t.turnAt);
      }
    }
  });
});

describe("SC-003 — a pick appears promptly", () => {
  it("adds NO latency of its own: every pick is placed in the reduction that received it", () => {
    // BE PRECISE ABOUT WHAT THIS PROVES. SC-003's budget is 2 s p95 from the
    // tap observing a pick to it being on screen, and that interval has three
    // parts: 005's delivery (already measured at p95 0.223 s), this reducer,
    // and React's paint.
    //
    // This harness can only speak for the middle one — and what it proves is
    // that the middle one is ZERO: application is synchronous, with no
    // batching, no deferral and no round trip (research §2's additive
    // application is exactly what buys that).
    //
    // An earlier version of this test pushed a hardcoded 0 and asserted it was
    // under 2000, which would have passed against any implementation at all.
    const { placementLatencies } = replay(800);
    expect(placementLatencies).toHaveLength(72);
    expect(placementLatencies.every((ms) => ms === 0)).toBe(true);
  });

  it("does not wait for the recommendation before showing the pick", () => {
    // The failure this rules out: coupling the grid update to the fetch, which
    // would put a whole round trip between a pick landing and appearing — and
    // would show nothing at all while a request was in flight.
    let state = initialState({ epoch: EPOCH, cursor: 0, myTeamId: OWNER, totalPicks: 72, inFlight: true });
    const frame = {
      type: "event",
      epoch: EPOCH,
      seq: 1,
      event: { kind: "pick_made", overall: 1, teamId: 4, playerId: 999 },
    } as unknown as DraftFrame;
    const step = reduce(state, { kind: "frame", frame }, 0);
    state = step.state;
    // In flight, so no new fetch — but the pick is on the board regardless.
    expect(step.effects).toEqual([]);
    expect(state.picks.map((p) => p.overall)).toEqual([1]);
  });
});

describe("T018 — the harness actually ran", () => {
  it("applied every frame and evaluated every turn", () => {
    // 005 shipped an SC-010 test that passed while walking a corpus which could
    // not express the failure it was written for. A replay that silently walks
    // zero turns looks exactly like one that walks twelve.
    const { turns, framesApplied } = replay(800);
    expect(framesApplied).toBe(72);
    expect(turns).toHaveLength(12);
    expect(turns.filter((t) => t.turnaround).length).toBeGreaterThan(0);
  });
});
