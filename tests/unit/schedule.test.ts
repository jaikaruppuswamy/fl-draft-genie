// 005 T012 — ESPN read cadence and back-off (FR-008, SC-008).

import { describe, expect, it } from "vitest";
import {
  ARMED_POLL_MS,
  LIVE_FLAG_POLL_MS,
  MAX_ESPN_REQUESTS_PER_MINUTE,
  nextEspnDelayMs,
  nextEspnReadMs,
  type SessionStatus,
} from "../../src/draft/schedule";

describe("back-off ladder", () => {
  it("climbs 5 → 10 → 20 → 40 → 60 s and caps", () => {
    const seen = [1, 2, 3, 4, 5, 6, 20].map((n) =>
      nextEspnDelayMs({ consecutiveErrors: n, lastError: "espn_unreachable" }),
    );
    expect(seen).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it("resets to no back-off on the first success", () => {
    expect(nextEspnDelayMs({ consecutiveErrors: 0, lastError: null })).toBeNull();
  });

  it("ladders espn_rejected — the owner can fix credentials mid-draft", () => {
    expect(nextEspnDelayMs({ consecutiveErrors: 2, lastError: "espn_rejected" })).toBe(10_000);
  });

  it("goes TERMINAL on league_not_found rather than hammering a 404 forever", () => {
    // A 404 does not become a 200 by waiting.
    expect(nextEspnDelayMs({ consecutiveErrors: 1, lastError: "league_not_found" })).toBeNull();
    expect(nextEspnDelayMs({ consecutiveErrors: 9, lastError: "league_not_found" })).toBeNull();
  });
});

describe("nextEspnReadMs", () => {
  const clean = { consecutiveErrors: 0, lastError: null } as const;

  it("polls slowly while armed, waiting for the published order", () => {
    expect(nextEspnReadMs({ ...clean, status: "armed" })).toBe(ARMED_POLL_MS);
  });

  it("polls slowly while live — only for the inProgress/drafted flags", () => {
    // Picks come from the tap. No ESPN request is on the pick path.
    expect(nextEspnReadMs({ ...clean, status: "live" })).toBe(LIVE_FLAG_POLL_MS);
  });

  it("keeps watching while not_receiving, which is how a recovery is noticed", () => {
    expect(nextEspnReadMs({ ...clean, status: "not_receiving" })).toBe(LIVE_FLAG_POLL_MS);
  });

  it("schedules NOTHING once terminal", () => {
    for (const s of ["complete", "aborted", "unsupported"] as SessionStatus[]) {
      expect(nextEspnReadMs({ ...clean, status: s }), s).toBeNull();
    }
  });

  it("schedules nothing while idle — a tap arms the session, not a timer", () => {
    expect(nextEspnReadMs({ ...clean, status: "idle" })).toBeNull();
  });

  it("lets back-off override the normal cadence", () => {
    expect(nextEspnReadMs({ status: "live", consecutiveErrors: 3, lastError: "espn_unreachable" })).toBe(20_000);
  });

  it("stops entirely on league_not_found even while live", () => {
    expect(nextEspnReadMs({ status: "live", consecutiveErrors: 1, lastError: "league_not_found" })).toBeNull();
  });
});

describe("the documented rate bound", () => {
  it("is 5/min, and the busiest cadence fits inside it", () => {
    // Sized to the pattern the design actually produces: an arm (3 reads)
    // overlapping one liveness poll. The old 25/min was sized around a 3 s poll
    // tier that no longer exists.
    expect(MAX_ESPN_REQUESTS_PER_MINUTE).toBe(5);
    expect(60_000 / LIVE_FLAG_POLL_MS).toBeLessThanOrEqual(MAX_ESPN_REQUESTS_PER_MINUTE);
  });
});
