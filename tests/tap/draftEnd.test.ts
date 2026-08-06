// 010 T045 — draft-end detection (FR-024, SC-014).
//
// The shipped version of this passed review while being unable to fire: it
// counted only the ledger, and in a single-session draft no ledger arrives
// after the last pick. These tests are written against the draft shape that was
// actually observed, not against a convenient one.

import { describe, expect, it, vi } from "vitest";
import { DraftEnd, type DraftEndPorts } from "../../tap/draftEnd";
import type { TapState } from "../../tap/status";

function harness(initial: TapState = "relaying") {
  let state = initial;
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const ports: DraftEndPorts = {
    render: vi.fn((s: TapState) => { state = s; }),
    announce: vi.fn(),
    flush: vi.fn(),
    currentState: () => state,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, ms, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  return {
    ports,
    de: new DraftEnd(ports),
    state: () => state,
    /** Fire the one pending idle timer, as a long silence would. */
    idle: () => { const t = timers[timers.length - 1]; t?.fn(); },
    pending: () => timers.length,
  };
}

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("DraftEnd", () => {
  it("counts the UNION of incremental picks and the ledger", () => {
    // The observed draft exactly: 69 picks arrived as SELECTED frames, and 3
    // more existed ONLY in the ledger. 69 + 3 = 72 = complete. Counting either
    // source alone stalls at 69 and never reports the draft over.
    const h = harness();
    for (const id of ids(1, 69)) h.de.notePicks([id]);
    expect(h.de.finished).toBe(false);
    h.de.notePicks(ids(70, 72), 72);
    expect(h.de.finished).toBe(true);
    expect(h.de.seenCount).toBe(72);
  });

  it("does NOT finish on the incremental stream alone", () => {
    const h = harness();
    h.de.notePicks([], 72); // ledger seen, total known
    for (const id of ids(1, 69)) h.de.notePicks([id]);
    expect(h.de.finished).toBe(false);
    expect(h.state()).not.toBe("draft-finished");
  });

  it("does NOT finish on a ledger that is itself incomplete", () => {
    const h = harness();
    h.de.notePicks(ids(1, 69), 72);
    expect(h.de.finished).toBe(false);
  });

  it("never guesses the total — many picks and no ledger is not 'finished'", () => {
    // The denominator is knowable only from a ledger. A false "finished" is the
    // worse error: unlike a false "still running", it stops the relay.
    const h = harness();
    h.de.notePicks(ids(1, 500));
    expect(h.de.finished).toBe(false);
    expect(h.de.totalSlots).toBe(0);
  });

  it("STOPS relaying picks and ledgers once finished, but not status", () => {
    // FR-024. Status must keep flowing: stopping the relay cannot also stop the
    // tap explaining why it stopped.
    const h = harness();
    h.de.notePicks(ids(1, 72), 72);
    expect(h.de.finished).toBe(true);
    expect(h.de.shouldRelay("pick")).toBe(false);
    expect(h.de.shouldRelay("ledger")).toBe(false);
    expect(h.de.shouldRelay("status")).toBe(true);
  });

  it("relays everything before the draft is finished", () => {
    const h = harness();
    h.de.notePicks(ids(1, 10), 72);
    for (const k of ["pick", "ledger", "status"] as const) expect(h.de.shouldRelay(k)).toBe(true);
  });

  it("flushes the buffer on completion — only NEW picks stop", () => {
    const h = harness();
    h.de.notePicks(ids(1, 72), 72);
    expect(h.ports.flush).toHaveBeenCalled();
    expect(h.ports.render).toHaveBeenCalledWith("draft-finished", expect.stringContaining("72/72"));
  });

  it("deduplicates by pick identity, so a replayed ledger cannot inflate the count", () => {
    // The ledger is re-sent on every reconnect and overlaps the stream almost
    // entirely. Counting arrivals rather than identities would finish early.
    const h = harness();
    h.de.notePicks(ids(1, 40), 72);
    h.de.notePicks(ids(1, 40), 72);
    h.de.notePicks(ids(1, 40), 72);
    expect(h.de.seenCount).toBe(40);
    expect(h.de.finished).toBe(false);
  });

  it("counts negative player ids, which are D/ST and not sentinels", () => {
    const h = harness();
    h.de.notePicks([-16007, -16021], 2);
    expect(h.de.seenCount).toBe(2);
    expect(h.de.finished).toBe(true);
  });

  it("says it cannot tell when the room goes quiet without completing", () => {
    // SC-014: idle and dead must not look alike.
    const h = harness();
    h.de.notePicks(ids(1, 30));
    h.idle();
    expect(h.ports.render).toHaveBeenCalledWith("draft-end-unknown", expect.stringContaining("30/?"));
  });

  it("reports the known total in the uncertain message when it has one", () => {
    const h = harness();
    h.de.notePicks(ids(1, 30), 72);
    h.idle();
    expect(h.ports.render).toHaveBeenCalledWith("draft-end-unknown", expect.stringContaining("30/72"));
  });

  it("stays quiet when it never saw a draft at all", () => {
    // "Waiting for picks" is honest here; claiming uncertainty would be noise.
    const h = harness("watching");
    h.idle();
    expect(h.ports.render).not.toHaveBeenCalled();
  });

  it("does not paper over a louder problem already on screen", () => {
    for (const loud of ["incompatible", "version-rejected"] as const) {
      const h = harness(loud);
      h.de.notePicks(ids(1, 5));
      h.idle();
      expect(h.ports.render).not.toHaveBeenCalledWith("draft-end-unknown", expect.anything());
    }
  });

  it("cancels the uncertainty timer once the draft is confirmed finished", () => {
    const h = harness();
    h.de.notePicks(ids(1, 72), 72);
    expect(h.pending()).toBe(0);
  });

  it("re-arms the silence timer on every pick, so only real silence trips it", () => {
    const h = harness();
    h.de.notePicks([1]);
    h.de.notePicks([2]);
    h.de.notePicks([3]);
    expect(h.pending()).toBe(1); // never accumulates
  });
});

describe("011 T038 — announcing completion ON THE RELAY", () => {
  // The badge and the status POST already say `draft-finished`, and neither
  // reaches a leaguemate's session: one is for the human at the keyboard, the
  // other is per-connection. This is the signal that travels with the frames.

  it("announces once, with the counts as evidence", () => {
    const h = harness();
    h.de.notePicks(ids(1, 72), 72);

    expect(h.ports.announce).toHaveBeenCalledTimes(1);
    expect(h.ports.announce).toHaveBeenCalledWith({ seen: 72, total: 72 });
  });

  it("announces BEFORE flushing, so the signal ships with its own evidence", () => {
    // A batch late, the receiver has already applied the ledger it describes.
    const h = harness();
    const order: string[] = [];
    (h.ports.announce as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("announce"));
    (h.ports.flush as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("flush"));

    h.de.notePicks(ids(1, 72), 72);
    expect(order).toEqual(["announce", "flush"]);
  });

  it("stays silent while the draft is still running", () => {
    // The whole value is that it means something. Announced on every pick, it
    // would be noise, and the receiver could not use it to reject anything.
    const h = harness();
    for (const id of ids(1, 71)) h.de.notePicks([id]);
    h.de.notePicks(ids(1, 71), 72);

    expect(h.ports.announce).not.toHaveBeenCalled();
  });

  it("stays silent when the total is unknown, however many picks arrive", () => {
    // Rule 2 of this module: never guess the denominator. A false completion is
    // the worse error because it stops the relay.
    const h = harness();
    h.de.notePicks(ids(1, 200));

    expect(h.ports.announce).not.toHaveBeenCalled();
    expect(h.de.finished).toBe(false);
  });

  it("does not re-announce as more frames arrive after the end", () => {
    const h = harness();
    h.de.notePicks(ids(1, 72), 72);
    h.de.notePicks(ids(1, 72), 72);

    expect(h.ports.announce).toHaveBeenCalledTimes(1);
  });
});
