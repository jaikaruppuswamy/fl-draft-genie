// 005 T008 — the feed cursor (FR-007h).
//
// The cursor is the piece whose failure is quietest: an off-by-one skips a pick
// and nothing errors. So the tests pin the two properties that a plausible-
// looking implementation gets wrong — a row inserted mid-read must not be
// skipped, and the cursor must not advance past an uncommitted batch.

import { describe, expect, it } from "vitest";
import {
  EMPTY_PLAYER_ID,
  advanceCursor,
  compareBatches,
  foldBatches,
  isAfter,
  isFilled,
  type FeedBatch,
  type RelayMessage,
} from "../../src/draft/feed";

const msg = (over: Partial<RelayMessage> = {}): RelayMessage => ({
  v: 1,
  seq: 1,
  epoch: 0,
  observedAt: "2026-08-30T23:14:07.221Z",
  transport: "ws",
  kind: "pick",
  payload: { teamId: 5, playerId: 4362628, slot3: 3 },
  ...over,
});

const batch = (over: Partial<FeedBatch> = {}): FeedBatch => ({
  id: "b1",
  receivedAt: "2026-08-30T23:14:07.000Z",
  installId: "i",
  sessionId: "s",
  firstSeq: 1,
  lastSeq: 1,
  messages: [msg()],
  ...over,
});

describe("keyset ordering", () => {
  it("orders by received_at, then by id", () => {
    const a = { receivedAt: "2026-01-01T00:00:00.000Z", id: "b" };
    const b = { receivedAt: "2026-01-01T00:00:00.000Z", id: "c" };
    const c = { receivedAt: "2026-01-01T00:00:01.000Z", id: "a" };
    expect(compareBatches(a, b)).toBeLessThan(0);
    expect(compareBatches(c, a)).toBeGreaterThan(0);
    expect(compareBatches(a, a)).toBe(0);
  });

  it("resolves ties on identical received_at by id, so no row is ambiguous", () => {
    // Two batches can land in the same millisecond under autodraft, which
    // produced ~1 pick/second in a real draft. Without the id tiebreak one of
    // them is either skipped or replayed forever.
    const cursor = { receivedAt: "2026-01-01T00:00:00.000Z", id: "b" };
    expect(isAfter(cursor, { receivedAt: "2026-01-01T00:00:00.000Z", id: "c" })).toBe(true);
    expect(isAfter(cursor, { receivedAt: "2026-01-01T00:00:00.000Z", id: "a" })).toBe(false);
    expect(isAfter(cursor, { receivedAt: "2026-01-01T00:00:00.000Z", id: "b" })).toBe(false);
  });

  it("reads everything when there is no cursor yet", () => {
    expect(isAfter(null, { receivedAt: "2020-01-01T00:00:00.000Z", id: "a" })).toBe(true);
  });

  it("does NOT skip a batch inserted mid-read", () => {
    // The offset-pagination bug: a row arriving between two reads shifts the
    // window and is silently never seen. A keyset cannot do that, because it
    // is anchored to a value rather than a position.
    const cursor = { receivedAt: "2026-01-01T00:00:00.000Z", id: "b" };
    const inserted = { receivedAt: "2026-01-01T00:00:00.500Z", id: "a" };
    expect(isAfter(cursor, inserted)).toBe(true);
  });
});

describe("advanceCursor", () => {
  it("advances to the last batch in keyset order, not arrival order", () => {
    const out = advanceCursor(null, [
      batch({ id: "b2", receivedAt: "2026-01-01T00:00:02.000Z" }),
      batch({ id: "b1", receivedAt: "2026-01-01T00:00:01.000Z" }),
    ]);
    expect(out).toEqual({ receivedAt: "2026-01-01T00:00:02.000Z", id: "b2" });
  });

  it("does NOT advance on an empty read", () => {
    // Advancing past nothing would skip whatever lands next.
    const prev = { receivedAt: "2026-01-01T00:00:00.000Z", id: "b" };
    expect(advanceCursor(prev, [])).toEqual(prev);
    expect(advanceCursor(null, [])).toBeNull();
  });
});

describe("the empty-slot sentinel", () => {
  it("treats ONLY -1 as empty", () => {
    expect(isFilled(EMPTY_PLAYER_ID)).toBe(false);
    expect(isFilled(4362628)).toBe(true);
  });

  it("keeps D/ST picks, whose ids are legitimately negative", () => {
    // `playerId > 0` made 010's capture script report 66 of 72 picks for a
    // complete draft, and this feature's own data model once carried the same
    // rule. Nothing may filter on sign.
    expect(isFilled(-16007)).toBe(true);
    expect(isFilled(-16021)).toBe(true);
  });
});

describe("foldBatches", () => {
  it("collects incremental picks in seq order across batches", () => {
    const o = foldBatches(null, [
      batch({ id: "b2", receivedAt: "2026-01-01T00:00:02.000Z", messages: [msg({ seq: 3, payload: { teamId: 1, playerId: 3, slot3: 0 } })] }),
      batch({ id: "b1", receivedAt: "2026-01-01T00:00:01.000Z", messages: [msg({ seq: 2, payload: { teamId: 2, playerId: 2, slot3: 0 } })] }),
    ]);
    expect(o.picks.map((p) => p.playerId)).toEqual([2, 3]);
  });

  it("keeps a D/ST pick through the fold", () => {
    const o = foldBatches(null, [batch({ messages: [msg({ payload: { teamId: 4, playerId: -16007, slot3: 0 } })] })]);
    expect(o.picks.map((p) => p.playerId)).toEqual([-16007]);
  });

  it("drops the -1 sentinel from a ledger without dropping the negatives", () => {
    const o = foldBatches(null, [
      batch({
        messages: [
          msg({
            kind: "ledger",
            payload: [
              { teamId: 1, playerId: 100, slot3: 0 },
              { teamId: 0, playerId: -1, slot3: 0 },
              { teamId: 3, playerId: -16007, slot3: 0 },
            ],
          }),
        ],
      }),
    ]);
    expect(o.ledger!.map((p) => p.playerId)).toEqual([100, -16007]);
  });

  it("lets a fuller ledger supersede a smaller one — it is a snapshot, not a delta", () => {
    const o = foldBatches(null, [
      batch({ id: "b1", receivedAt: "2026-01-01T00:00:01.000Z", messages: [msg({ kind: "ledger", payload: [{ teamId: 1, playerId: 1, slot3: 0 }] })] }),
      batch({ id: "b2", receivedAt: "2026-01-01T00:00:02.000Z", messages: [msg({ kind: "ledger", payload: [{ teamId: 1, playerId: 1, slot3: 0 }, { teamId: 2, playerId: 2, slot3: 0 }] })] }),
    ]);
    expect(o.ledger).toHaveLength(2);
  });

  it("carries the observation epoch, which stamps are only comparable within", () => {
    const o = foldBatches(null, [batch({ messages: [msg({ epoch: 2 })] })]);
    expect(o.picks[0]!.epoch).toBe(2);
  });

  it("carries slot3 opaquely without interpreting it", () => {
    // Field 3 is UNRESOLVED — the independent oracle disproved "round" at 5/70.
    const o = foldBatches(null, [batch({ messages: [msg({ payload: { teamId: 1, playerId: 9, slot3: 7 } })] })]);
    expect(o.picks[0]!.slot3).toBe(7);
    expect(o.picks[0]).not.toHaveProperty("round");
  });

  it("collects status frames, which drive withholding", () => {
    const o = foldBatches(null, [batch({ messages: [msg({ kind: "status", payload: { state: "incompatible" } })] })]);
    expect(o.statuses).toEqual([{ state: "incompatible", observedAt: "2026-08-30T23:14:07.221Z" }]);
  });

  it("ignores a malformed pick rather than throwing mid-draft", () => {
    const o = foldBatches(null, [batch({ messages: [msg({ payload: { teamId: "x", playerId: null } })] })]);
    expect(o.picks).toEqual([]);
  });
});

describe("ordering and ledger selection (regressions)", () => {
  it("sorts messages by seq WITHIN a batch, not just across batches", () => {
    // Deleting the within-batch sort used to keep the entire suite green,
    // because every fixture batch carried one message. A tap flush that merges
    // a retained buffer with newly observed frames can carry them out of
    // order, and then two picks swap overall numbers silently.
    const o = foldBatches(null, [
      batch({
        messages: [
          msg({ seq: 2, payload: { teamId: 1, playerId: 202, slot3: 0 } }),
          msg({ seq: 1, payload: { teamId: 1, playerId: 201, slot3: 0 } }),
        ],
      }),
    ]);
    expect(o.picks.map((p) => p.playerId)).toEqual([201, 202]);
  });

  it("keeps the FULLEST ledger in a read, not the last-arriving one", () => {
    // A tap buffering through an outage flushes an OLD snapshot with a NEW
    // received_at. Ordering by arrival threw away a 40-row ledger for a stale
    // 5-row one — discarding the recovery data the ledger exists to provide.
    const ledgerBatch = (id: string, receivedAt: string, rows: number) =>
      batch({
        id,
        receivedAt,
        messages: [
          msg({
            kind: "ledger",
            payload: Array.from({ length: rows }, (_, i) => ({
              teamId: 0,
              playerId: 2000 + i,
              slot3: 0,
              overallPickNumber: i + 1,
            })),
          }),
        ],
      });
    const o = foldBatches(null, [
      ledgerBatch("a", "2026-01-01T00:00:01.000Z", 40),
      ledgerBatch("b", "2026-01-01T00:00:02.000Z", 5),
    ]);
    expect(o.ledger).toHaveLength(40);
  });
});
