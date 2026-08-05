// 010 T055 — periodic liveness (005 FR-007e).
//
// The property under test is easy to state and easy to get wrong: a HEALTHY tap
// must keep speaking. Before this, the tap reported only on state change, so a
// tap that was working perfectly said nothing at all — indistinguishable, to the
// receiver, from one that had died.

import { describe, expect, it } from "vitest";
import { HEARTBEAT_MIN_GAP_MS, HEARTBEAT_MS, shouldSendHeartbeat } from "../../tap/heartbeat";

const at = (o: Partial<Parameters<typeof shouldSendHeartbeat>[0]> = {}) =>
  shouldSendHeartbeat({ now: 1_000_000, lastSentAt: null, paired: true, triggeredByEvent: false, ...o });

describe("shouldSendHeartbeat", () => {
  it("sends immediately on the first call, so liveness starts at attach", () => {
    expect(at({ lastSentAt: null })).toEqual({ send: true, reason: "first" });
  });

  it("sends once the nominal interval has elapsed", () => {
    expect(at({ lastSentAt: 1_000_000 - HEARTBEAT_MS }).send).toBe(true);
    expect(at({ lastSentAt: 1_000_000 - HEARTBEAT_MS - 1 }).send).toBe(true);
  });

  it("does NOT send before the interval, so the timer alone cannot spam", () => {
    expect(at({ lastSentAt: 1_000_000 - (HEARTBEAT_MS - 1) })).toEqual({ send: false, reason: "too-soon" });
  });

  it("sends early when woken by an event, which is what a throttled tab depends on", () => {
    // A hidden tab's timers stretch to ~1/minute. visibilitychange/pageshow/
    // online are what make a wake-up visible to the receiver promptly instead
    // of up to a minute later.
    const justUnderInterval = 1_000_000 - (HEARTBEAT_MS - 1);
    expect(at({ lastSentAt: justUnderInterval, triggeredByEvent: true })).toEqual({ send: true, reason: "event" });
  });

  it("still refuses inside the minimum gap, even for an event", () => {
    // Otherwise a burst of focus/visibility/online events becomes a burst of
    // requests — the tap must never become a load source on draft night.
    const veryRecent = 1_000_000 - (HEARTBEAT_MIN_GAP_MS - 1);
    expect(at({ lastSentAt: veryRecent, triggeredByEvent: true })).toEqual({ send: false, reason: "too-soon" });
  });

  it("never sends while unpaired — there is nowhere to send it", () => {
    expect(at({ paired: false })).toEqual({ send: false, reason: "not-paired" });
    expect(at({ paired: false, triggeredByEvent: true, lastSentAt: null })).toEqual({
      send: false,
      reason: "not-paired",
    });
  });

  it("the minimum gap is well below the interval, or events could never fire early", () => {
    expect(HEARTBEAT_MIN_GAP_MS).toBeLessThan(HEARTBEAT_MS);
  });
});
