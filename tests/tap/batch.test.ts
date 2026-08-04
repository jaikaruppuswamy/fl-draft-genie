// 010 T021/T023 — sequencing, timing epochs, back-off and the buffer.

import { describe, expect, it } from "vitest";
import { Sequencer, chunk, backoffMs, EPOCH_DRIFT_MS, type Clock, type RelayMessage } from "../../tap/batch";
import { Buffer as TapBuffer, type StoragePort } from "../../tap/buffer";

const league = { espnLeagueId: "9999999999", season: 2026 };

class FakeClock implements Clock {
  wall = 1_800_000_000_000;
  mono = 0;
  now() { return this.wall; }
  monotonic() { return this.mono; }
  /** Simulate machine sleep: wall clock jumps, monotonic stalls. */
  sleep(ms: number) { this.wall += ms; }
  tick(ms: number) { this.wall += ms; this.mono += ms; }
}

const memory = (): StoragePort => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
};

describe("Sequencer", () => {
  it("emits a monotonic seq within one session", () => {
    const s = new Sequencer(new FakeClock(), "i", "s", league);
    expect([s.build("pick", {}, "ws").seq, s.build("pick", {}, "ws").seq, s.build("pick", {}, "ws").seq])
      .toEqual([0, 1, 2]);
  });

  it("bumps the epoch when the wall clock jumps but monotonic does not (sleep)", () => {
    const c = new FakeClock();
    const s = new Sequencer(c, "i", "s", league);
    expect(s.currentEpoch()).toBe(0);
    c.sleep(EPOCH_DRIFT_MS + 5_000);
    expect(s.reanchor()).toBe(true);
    expect(s.currentEpoch()).toBe(1);
    // 005 must not compare stamps across epochs as one timeline.
    expect(s.build("pick", {}, "ws").epoch).toBe(1);
  });

  it("does not bump the epoch for ordinary elapsed time", () => {
    const c = new FakeClock();
    const s = new Sequencer(c, "i", "s", league);
    c.tick(60_000);
    expect(s.reanchor()).toBe(false);
    expect(s.currentEpoch()).toBe(0);
  });

  it("stamps the contract and tap versions on every message (FR-022)", () => {
    const m = new Sequencer(new FakeClock(), "i", "s", league).build("pick", { teamId: 1 }, "sse");
    expect(m.v).toBe(1);
    expect(m.tapVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.transport).toBe("sse");
  });
});

describe("chunk / backoff", () => {
  it("preserves order across batches", () => {
    const s = new Sequencer(new FakeClock(), "i", "s", league);
    const msgs = Array.from({ length: 450 }, () => s.build("pick", {}, "ws"));
    const batches = chunk(msgs);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat().map((m) => m.seq)).toEqual(msgs.map((m) => m.seq));
  });

  it("backs off exponentially with a cap, and honours Retry-After", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(20)).toBe(30_000);
    expect(backoffMs(1, 5)).toBe(5000);
    expect(backoffMs(1, 999)).toBe(60_000);
  });
});

describe("Buffer", () => {
  const msg = (seq: number): RelayMessage =>
    ({ seq, kind: "pick", payload: { teamId: 1, playerId: 2, slot3: 3 } }) as RelayMessage;

  it("survives a reload by reloading from storage", () => {
    const store = memory();
    const a = new TapBuffer(store, "i", "s");
    a.append(msg(0)); a.append(msg(1));
    expect(new TapBuffer(store, "i", "s").size()).toBe(2);
  });

  it("truncates ONLY on an acknowledgement, never on send", () => {
    const b = new TapBuffer(memory(), "i", "s");
    [0, 1, 2, 3].forEach((n) => b.append(msg(n)));
    expect(b.truncate(1)).toBe(2);
    expect(b.pending().map((m) => m.seq)).toEqual([2, 3]);
  });

  it("keeps everything when the ack is behind the buffer", () => {
    const b = new TapBuffer(memory(), "i", "s");
    [5, 6].forEach((n) => b.append(msg(n)));
    expect(b.truncate(4)).toBe(0);
    expect(b.size()).toBe(2);
  });

  it("uses per-session keys so two tabs never collide", () => {
    const store = memory();
    new TapBuffer(store, "i", "tabA").append(msg(0));
    expect(new TapBuffer(store, "i", "tabB").size()).toBe(0);
  });

  it("recovers from a corrupt buffer instead of wedging", () => {
    const store = memory();
    store.set("dg:buf:i:s", "{not json");
    expect(new TapBuffer(store, "i", "s").size()).toBe(0);
  });

  it("keeps recording when storage throws (over quota)", () => {
    const bad: StoragePort = { get: () => null, set: () => { throw new Error("quota"); }, remove: () => {} };
    const b = new TapBuffer(bad, "i", "s");
    expect(() => b.append(msg(0))).not.toThrow();
    expect(b.size()).toBe(1);
  });
});
