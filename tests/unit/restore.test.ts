// 005 T042/T043 — the cron sweep's decisions.

import { describe, expect, it } from "vitest";
import { sweepAction, type SweepRow } from "../../src/draft/restore";
import { ARMED_DEADLINE_MS } from "../../src/draft/arming";

const NOW = Date.parse("2026-08-30T23:00:00.000Z");
const row = (over: Partial<SweepRow> = {}): SweepRow => ({
  connection_id: "c1",
  season: 2026,
  status: "live",
  armed_at: "2026-08-30T22:00:00.000Z",
  scheduled_at: "2026-08-30T22:30:00.000Z",
  completed_at: null,
  archived_at: null,
  ...over,
});

describe("sweepAction", () => {
  it("restores a live session, because nothing else would notice it died", () => {
    // A deploy restarts every Durable Object. With no client attached, the tap
    // keeps relaying into the log and nothing wakes the session up.
    expect(sweepAction(row(), NOW)).toEqual({ kind: "restore" });
  });

  it("restores an armed session that is still inside its deadline", () => {
    expect(sweepAction(row({ status: "armed" }), NOW).kind).toBe("restore");
  });

  it("restores a not_receiving session, which is how a recovery gets noticed", () => {
    expect(sweepAction(row({ status: "not_receiving" }), NOW).kind).toBe("restore");
  });

  it("NEVER resurrects a completed draft", () => {
    // Without this the cron restarts a finished draft every five minutes,
    // forever.
    expect(sweepAction(row({ completed_at: "2026-08-30T22:59:00.000Z" }), NOW).kind).toBe("skip");
    expect(sweepAction(row({ status: "complete" }), NOW).kind).toBe("skip");
  });

  it("never resurrects an archived, aborted or unsupported session", () => {
    expect(sweepAction(row({ archived_at: "2026-08-30T22:59:00.000Z" }), NOW).kind).toBe("skip");
    expect(sweepAction(row({ status: "aborted" }), NOW).kind).toBe("skip");
    expect(sweepAction(row({ status: "unsupported" }), NOW).kind).toBe("skip");
  });

  it("ABORTS an armed session past its absolute deadline", () => {
    // A postponed draft would otherwise hold an alarm open indefinitely —
    // roughly 11,000 GB-s a day for a draft that never happened.
    const stale = new Date(NOW - ARMED_DEADLINE_MS - 60_000).toISOString();
    expect(sweepAction(row({ status: "armed", scheduled_at: stale }), NOW)).toEqual({
      kind: "abort",
      why: "armed_deadline",
    });
  });

  it("does NOT abort a LIVE session that started long ago", () => {
    // Long drafts exist. The deadline is about a draft that never began, not
    // one that is simply slow — aborting mid-draft would be the worst outcome.
    const stale = new Date(NOW - ARMED_DEADLINE_MS - 60_000).toISOString();
    expect(sweepAction(row({ status: "live", scheduled_at: stale }), NOW).kind).toBe("restore");
  });

  it("falls back to armed_at when ESPN never published a draft time", () => {
    const stale = new Date(NOW - ARMED_DEADLINE_MS - 60_000).toISOString();
    expect(sweepAction(row({ status: "armed", scheduled_at: null, armed_at: stale }), NOW).kind).toBe("abort");
  });

  it("never aborts a session with no anchor at all", () => {
    expect(sweepAction(row({ status: "armed", scheduled_at: null, armed_at: null }), NOW).kind).toBe("restore");
  });
});
