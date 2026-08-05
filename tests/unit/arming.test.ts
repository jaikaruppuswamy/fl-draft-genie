// 005 T037/T038 — the arming scope, and the total that makes completion reachable.

import { describe, expect, it } from "vitest";
import { armedDeadlinePassed, armingScope, totalPicksFrom, ARMED_DEADLINE_MS } from "../../src/draft/arming";

const roster = (starting: number, bench: number) => JSON.stringify({ starting_slots: starting, bench_slots: bench });

const base = {
  accountId: "a",
  connectionId: "c",
  espnLeagueId: "9",
  season: 2026,
  myTeamId: 1,
};

describe("totalPicksFrom", () => {
  it("is teams × roster spots — every spot is one pick", () => {
    // 6 teams, 9 starters + 7 bench = 96 picks.
    expect(totalPicksFrom(6, roster(9, 7))).toBe(96);
  });

  it("returns 0 — 'not yet known' — when the roster is missing", () => {
    // THE BUG THIS REPLACES: this was hardcoded to 0, so completion was
    // unreachable in production. The session never finished, never wrote
    // `complete`, and therefore never archived. 0 must mean "unknown", not
    // "always".
    expect(totalPicksFrom(6, null)).toBe(0);
    expect(totalPicksFrom(0, roster(9, 7))).toBe(0);
    expect(totalPicksFrom(6, "{not json")).toBe(0);
    expect(totalPicksFrom(6, roster(0, 0))).toBe(0);
  });
});

describe("armingScope", () => {
  it("derives a real total, so a draft can actually complete", () => {
    const r = armingScope({
      ...base,
      snapshot: { team_count: 6, roster_json: roster(9, 7), draft_json: JSON.stringify({ type: "SNAKE", supported: true }) },
    });
    expect(r.scope.totalPicks).toBe(96);
  });

  it("keeps every unknown UNKNOWN rather than guessing", () => {
    // An empty order degrades orderTrust and suppresses turn events; a zero
    // total keeps completion unreachable. Both are honest absences.
    const r = armingScope({ ...base, snapshot: null });
    expect(r.scope.order).toEqual([]);
    expect(r.scope.totalPicks).toBe(0);
    expect(r.scheduledAt).toBeNull();
  });

  it("treats ABSENT draft settings as 'not published yet', not unsupported", () => {
    // ESPN publishes the order about an hour before. Marking this unsupported
    // would abort a session before ESPN has said anything about the draft.
    expect(armingScope({ ...base, snapshot: { team_count: 6, roster_json: null, draft_json: null } }).supported).toBe(
      true,
    );
  });

  it("marks a genuinely unsupported format", () => {
    const r = armingScope({
      ...base,
      snapshot: { team_count: 6, roster_json: null, draft_json: JSON.stringify({ type: "AUCTION", supported: false }) },
    });
    expect(r.supported).toBe(false);
  });

  it("carries the published order and scheduled time when they exist", () => {
    const r = armingScope({
      ...base,
      snapshot: {
        team_count: 6,
        roster_json: roster(9, 7),
        draft_json: JSON.stringify({ type: "SNAKE", supported: true, order: [5, 1, 4], scheduled_at: "2026-08-30T23:00:00.000Z" }),
      },
    });
    expect(r.scope.order).toEqual([5, 1, 4]);
    expect(r.scheduledAt).toBe("2026-08-30T23:00:00.000Z");
  });
});

describe("armedDeadlinePassed", () => {
  const NOW = Date.parse("2026-08-31T06:00:00.000Z");
  it("fires past the deadline, measured from the scheduled time", () => {
    const old = new Date(NOW - ARMED_DEADLINE_MS - 1000).toISOString();
    expect(armedDeadlinePassed(old, null, NOW)).toBe(true);
  });
  it("does not fire inside it", () => {
    expect(armedDeadlinePassed(new Date(NOW - 60_000).toISOString(), null, NOW)).toBe(false);
  });
  it("falls back to armed_at when ESPN published no draft time", () => {
    const old = new Date(NOW - ARMED_DEADLINE_MS - 1000).toISOString();
    expect(armedDeadlinePassed(null, old, NOW)).toBe(true);
  });
  it("never fires with no anchor at all", () => {
    expect(armedDeadlinePassed(null, null, NOW)).toBe(false);
  });
});
