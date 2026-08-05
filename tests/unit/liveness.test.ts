// 005 T010 — liveness and withholding (FR-007c/e/f, SC-001b, SC-001c).
//
// The two cases that matter most are both NEGATIVE ones, and both are drawn
// from measured behaviour rather than imagined:
//
//  * a 90 s gap BETWEEN PICKS with heartbeats still arriving is a normal human
//    round, not a dead tap — real drafts produced exactly this;
//  * a 45 s heartbeat gap on a HIDDEN tab is a throttled timer, not a dead tap
//    — and the ratified design expects that tab to be hidden.
//
// A rule that fires on either would cry wolf during the one hour it matters.

import { describe, expect, it } from "vitest";
import {
  LAPSE_HIDDEN_MS,
  LAPSE_VISIBLE_MS,
  heartbeatLapsed,
  isWithholding,
  lapseThresholdMs,
  withholdReason,
  type TapReportedState,
} from "../../src/draft/liveness";

const NOW = 1_800_000_000_000;
const ago = (ms: number) => NOW - ms;

describe("heartbeatLapsed", () => {
  it("lapses after 45 s on a VISIBLE tab", () => {
    expect(heartbeatLapsed({ lastHeartbeatAt: ago(46_000), hidden: false, now: NOW })).toBe(true);
    expect(heartbeatLapsed({ lastHeartbeatAt: ago(44_000), hidden: false, now: NOW })).toBe(false);
  });

  it("does NOT lapse at 45 s on a HIDDEN tab — those timers are throttled", () => {
    // The false alarm a single threshold would raise on essentially every
    // draft, because the tap's tab is normally the one nobody is looking at.
    expect(heartbeatLapsed({ lastHeartbeatAt: ago(46_000), hidden: true, now: NOW })).toBe(false);
    expect(heartbeatLapsed({ lastHeartbeatAt: ago(120_000), hidden: true, now: NOW })).toBe(false);
  });

  it("does lapse at 150 s even when hidden", () => {
    expect(heartbeatLapsed({ lastHeartbeatAt: ago(151_000), hidden: true, now: NOW })).toBe(true);
  });

  it("treats 'never heard from' as not-lapsed — there is nothing stale yet", () => {
    // Arming is what a first frame does (FR-007g); a session with no tap has
    // not gone stale, it has not started.
    expect(heartbeatLapsed({ lastHeartbeatAt: null, hidden: false, now: NOW })).toBe(false);
  });

  it("tolerates one dropped heartbeat before alarming", () => {
    // 15 s interval, 45 s threshold ⇒ two consecutive misses are survivable.
    expect(heartbeatLapsed({ lastHeartbeatAt: ago(30_000), hidden: false, now: NOW })).toBe(false);
  });

  it("exposes the thresholds it applies", () => {
    expect(lapseThresholdMs(false)).toBe(LAPSE_VISIBLE_MS);
    expect(lapseThresholdMs(true)).toBe(LAPSE_HIDDEN_MS);
    expect(LAPSE_HIDDEN_MS).toBeGreaterThan(60_000); // must clear a 1/minute timer
  });
});

describe("withholdReason (FR-007f)", () => {
  const live = { lastHeartbeatAt: ago(5_000), hidden: false, now: NOW };

  it("WITHHOLDS on incompatible — picks are provably being missed", () => {
    expect(withholdReason({ ...live, tapState: "incompatible" })).toBe("incompatible");
  });

  it("WITHHOLDS on version-rejected — the tap speaks a contract we refuse", () => {
    expect(withholdReason({ ...live, tapState: "version-rejected" })).toBe("version_rejected");
  });

  it("WITHHOLDS on a lapsed heartbeat", () => {
    expect(withholdReason({ lastHeartbeatAt: ago(60_000), hidden: false, now: NOW, tapState: "relaying" })).toBe(
      "not_receiving",
    );
  });

  it("does NOT withhold on buffering — the tap is working correctly", () => {
    // Its picks are retained and will arrive. Withholding through an ordinary
    // outage is what teaches an owner to ignore the indicator entirely.
    expect(withholdReason({ ...live, tapState: "buffering" })).toBeNull();
  });

  it("does NOT withhold on draft-end-unknown — the picks in hand are likely complete", () => {
    expect(withholdReason({ ...live, tapState: "draft-end-unknown" })).toBeNull();
  });

  it("does NOT withhold during a slow human round", () => {
    // THE case a silence-based rule gets wrong: 90 s between picks is normal,
    // and the heartbeat is the thing that proves it.
    expect(
      withholdReason({ lastHeartbeatAt: ago(10_000), hidden: false, now: NOW, tapState: "watching" }),
    ).toBeNull();
  });

  it("does not withhold on any healthy state", () => {
    for (const s of ["watching", "relaying", "paired", "draft-finished"] as TapReportedState[]) {
      expect(withholdReason({ ...live, tapState: s }), s).toBeNull();
    }
  });

  it("prefers the loud tap state over the lapse, so the reason is the actionable one", () => {
    expect(
      withholdReason({ lastHeartbeatAt: ago(600_000), hidden: false, now: NOW, tapState: "incompatible" }),
    ).toBe("incompatible");
  });

  it("isWithholding agrees with withholdReason in both directions", () => {
    expect(isWithholding({ ...live, tapState: "incompatible" })).toBe(true);
    expect(isWithholding({ ...live, tapState: "buffering" })).toBe(false);
  });
});
