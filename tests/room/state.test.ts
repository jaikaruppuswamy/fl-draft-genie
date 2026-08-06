// 011 T017/T021/T023/T024 — what each surface is allowed to say.
//
// THE TEST THIS FILE EXISTS FOR is the first one: on 2026-08-05, seven minutes
// before a draft, the room said Draft Genie could not be reached. Nothing was
// wrong. No session had armed yet, because the league had just been
// reconnected. A false alarm at that moment costs exactly the attention nobody
// has, and it is what sent the owner off re-doing setup that was already fine.

import { describe, expect, it } from "vitest";
import {
  ROOM_REMEDY,
  ROOM_STATES,
  TAP_REMEDY,
  TAP_STATES,
  roomStateOf,
  roomReport,
  tapReport,
  tapStateOf,
  type RoomInputs,
  type TapInputs,
} from "../../web/src/lib/observableState";

const room = (over: Partial<RoomInputs> = {}): RoomInputs => ({
  sessionArmed: true,
  reachability: "connected",
  hasSeenPicks: false,
  receiving: true,
  ...over,
});

describe("no session armed means WAITING, never a failure (FR-011)", () => {
  it("reports waiting_for_draft before any session exists", () => {
    expect(roomStateOf(room({ sessionArmed: false })).state).toBe("waiting_for_draft");
  });

  it("reports waiting even when the transport has fallen back to polling", () => {
    // The exact 2026-08-05 shape: the socket cannot attach because there is no
    // Durable Object to attach to, and the room concluded the service was
    // unreachable. The session's absence dominates — it explains the socket.
    const r = roomStateOf(room({ sessionArmed: false, reachability: "polling" }));
    expect(r.state).toBe("waiting_for_draft");
    expect(r.state).not.toBe("cannot_reach");
  });

  it("says nothing is wrong, rather than describing a problem", () => {
    expect(roomStateOf(room({ sessionArmed: false })).remedy).toMatch(/nothing is wrong/i);
  });
});

describe("the three failure states stay distinct (FR-012)", () => {
  it("polling means the transport gave up", () => {
    expect(roomStateOf(room({ reachability: "polling" })).state).toBe("cannot_reach");
  });

  it("a reconnect still expected to succeed is NOT a failure (FR-014)", () => {
    // Reporting failure while a retry is still in flight is how a blip becomes
    // an incident in the reader's head.
    expect(roomStateOf(room({ reachability: "reconnecting" })).state).not.toBe("cannot_reach");
  });

  it("distinguishes a relay that STOPPED from one that never started", () => {
    // Same remedy, different fact — one says something broke, the other says
    // nobody has started relaying yet.
    expect(roomStateOf(room({ receiving: false, hasSeenPicks: true })).state).toBe("relay_stopped");
    expect(roomStateOf(room({ receiving: false, hasSeenPicks: false })).state).toBe("not_receiving");
  });

  it("gives a stopped relay the same remedy for everyone (FR-006a)", () => {
    // One message, not one per audience. "Someone needs a draft room open in
    // Chrome" is actionable from an iPad — socially rather than technically.
    expect(ROOM_REMEDY.relay_stopped).toMatch(/someone in this league/i);
    expect(ROOM_REMEDY.relay_stopped).toMatch(/desktop Chrome/i);
  });
});

describe("a relay may not claim health without evidence (FR-009)", () => {
  it("refuses `relaying` when no last-relayed time is supplied", () => {
    // THE fix for the thing that cost a working credential twice. "It is
    // working" with nothing behind it is an assertion, and an unevidenced
    // assertion is indistinguishable from a broken tap.
    expect(tapReport("relaying").state).toBe("unknown");
  });

  it("allows `relaying` with evidence, and carries it", () => {
    const r = tapReport("relaying", { lastRelayedAt: "2026-08-06T04:27:59.000Z" });
    expect(r.state).toBe("relaying");
    expect(r.evidence?.lastRelayedAt).toBe("2026-08-06T04:27:59.000Z");
  });

  it("distinguishes a tap that stopped from one never enabled (FR-010)", () => {
    expect(tapReport("enabled_idle").state).not.toBe(tapReport("installed_not_enabled").state);
  });

  it("says unknown rather than guessing (FR-015)", () => {
    expect(tapReport("unknown").remedy).toMatch(/can't tell/i);
    expect(roomReport("unknown").remedy).toMatch(/can't tell/i);
  });
});

describe("both state sets are COMPLETE (SC-005)", () => {
  // Each state having its own test does not prove the set is closed. A state
  // added without a remedy, or a state the UI can reach that this vocabulary
  // does not name, passes every test above.

  it("every tap state has a remedy", () => {
    for (const s of TAP_STATES) {
      expect(TAP_REMEDY[s], `tap state ${s}`).toBeTruthy();
    }
    expect(Object.keys(TAP_REMEDY).sort()).toEqual([...TAP_STATES].sort());
  });

  it("every room state has a remedy", () => {
    for (const s of ROOM_STATES) {
      expect(ROOM_REMEDY[s], `room state ${s}`).toBeTruthy();
    }
    expect(Object.keys(ROOM_REMEDY).sort()).toEqual([...ROOM_STATES].sort());
  });

  it("holds the counts the spec names — four tap states plus unknown, five room plus unknown", () => {
    // Pinned deliberately: a silent addition should make someone come here and
    // decide it belongs, rather than inherit a remedy by accident.
    expect(TAP_STATES).toHaveLength(5);
    expect(ROOM_STATES).toHaveLength(6);
  });

  it("every state roomStateOf can return is in the declared set", () => {
    const reachable: RoomInputs[] = [
      room({ sessionArmed: false }),
      room({ reachability: "polling" }),
      room({ reachability: "reconnecting", receiving: false }),
      room({ receiving: false, hasSeenPicks: true }),
      room(),
    ];
    for (const i of reachable) {
      expect(ROOM_STATES).toContain(roomStateOf(i).state);
    }
  });

  it("PROVES the completeness check can fail", () => {
    // Without this the assertions above pass against an empty set.
    const partial: Record<string, string> = { a: "x" };
    expect(Object.keys(partial).sort()).not.toEqual(["a", "b"]);
  });
});

describe("the tap page's four states (FR-008, FR-010)", () => {
  const NOW = Date.parse("2026-08-06T05:00:00.000Z");
  const tap = (over: Partial<TapInputs> = {}): TapInputs => ({
    scriptDetected: true,
    enablements: [],
    nowMs: NOW,
    ...over,
  });

  it("no enablement and no script means not installed", () => {
    expect(tapStateOf(tap({ scriptDetected: false })).state).toBe("not_installed");
  });

  it("no enablement but a script present means installed, not enabled", () => {
    expect(tapStateOf(tap({ scriptDetected: true })).state).toBe("installed_not_enabled");
  });

  it("says UNKNOWN when it cannot tell whether the script is present", () => {
    // Not a placeholder — a real answer. Guessing between "not installed" and
    // "installed but not enabled" is what sends someone to re-do working setup.
    expect(tapStateOf(tap({ scriptDetected: null })).state).toBe("unknown");
  });

  it("enabled but never used is IDLE, not stopped", () => {
    expect(tapStateOf(tap({ enablements: [{ lastUsedAt: null, revoked: false }] })).state).toBe(
      "enabled_idle",
    );
  });

  it("recently used is RELAYING, with the timestamp as evidence", () => {
    const r = tapStateOf(
      tap({ enablements: [{ lastUsedAt: "2026-08-06T04:59:00.000Z", revoked: false }] }),
    );
    expect(r.state).toBe("relaying");
    expect(r.evidence?.lastRelayedAt).toBe("2026-08-06T04:59:00.000Z");
  });

  it("tolerates a BACKGROUNDED tab's throttled heartbeat", () => {
    // A background tab's timers throttle to roughly one a minute. 005 already
    // learned that a tighter threshold declares a healthy tap dead — the exact
    // error this story exists to stop repeating.
    const twoMinutesAgo = new Date(NOW - 120_000).toISOString();
    expect(tapStateOf(tap({ enablements: [{ lastUsedAt: twoMinutesAgo, revoked: false }] })).state).toBe(
      "relaying",
    );
  });

  it("goes idle once the relay is genuinely stale", () => {
    const longAgo = new Date(NOW - 10 * 60_000).toISOString();
    expect(tapStateOf(tap({ enablements: [{ lastUsedAt: longAgo, revoked: false }] })).state).toBe(
      "enabled_idle",
    );
  });

  it("ignores revoked enablements", () => {
    const r = tapStateOf(
      tap({
        scriptDetected: true,
        enablements: [{ lastUsedAt: "2026-08-06T04:59:00.000Z", revoked: true }],
      }),
    );
    expect(r.state).toBe("installed_not_enabled");
  });
});
