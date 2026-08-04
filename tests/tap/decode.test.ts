// 010 T015 — the ledger reader, tested against the real US1 capture and the
// INDEPENDENT oracle. Validating the capture against itself would prove
// nothing; the oracle is what lets these assertions fail.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeInitFrame, decodeLedger, filledPicks, LedgerFormatError, RECORD_STRIDE } from "../../tap/decode";

const frames = readFileSync("tests/fixtures/tap/capture-2026.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { data?: string; at?: string });

const oracle = JSON.parse(readFileSync("tests/fixtures/tap/oracle-2026.json", "utf8")) as {
  picks: { overallPickNumber: number; teamId: number; playerId: number }[];
};

const initFrames = frames.filter((f) => f.data?.startsWith("INIT "));
const nodeAtob = (s: string) => Buffer.from(s, "base64").toString("binary");
const decode = (i: number) => decodeInitFrame(initFrames[i]!.data!, nodeAtob)!;

describe("decodeLedger", () => {
  it("finds the pick array at a DIFFERENT offset in each ledger", () => {
    const empty = decode(0);
    const full = decode(1);
    expect(empty.totalSlots).toBe(72);
    expect(full.totalSlots).toBe(72);
    // The two ledgers are 7464 and 7472 bytes: the prefix ahead of the pick
    // array GREW by 8 bytes between them, within the same draft. So the array
    // offset is not stable even for one league, and a hardcoded constant would
    // have failed on the very first frame. Locating by invariant is what makes
    // the reader work at all — this assertion pins that property.
    expect(empty.arrayOffset).not.toBe(full.arrayOffset);
    expect(full.arrayOffset - empty.arrayOffset).toBe(8);
  });

  it("reads the pre-draft ledger as entirely empty", () => {
    expect(filledPicks(decode(0))).toHaveLength(0);
  });

  it("reads the mid-draft ledger and agrees with the oracle on every pick", () => {
    const picks = filledPicks(decode(1));
    expect(picks.length).toBeGreaterThan(0);
    const byPlayer = new Map(oracle.picks.map((p) => [p.playerId, p]));
    for (const p of picks) {
      const o = byPlayer.get(p.playerId);
      expect(o, `player ${p.playerId} missing from oracle`).toBeDefined();
      expect(p.teamId).toBe(o!.teamId);
      expect(p.overallPickNumber).toBe(o!.overallPickNumber);
    }
  });

  it("recovers the picks the incremental stream lost across a reload", () => {
    // The tap saw 27 SELECTED frames before the reconnect; the ledger holds 29.
    // The extra two are exactly what the reload dropped — this is the whole
    // reason FR-005 makes the ledger non-discretionary.
    const seen = new Set(
      frames
        .filter((f) => f.data?.startsWith("SELECTED ") && f.at! < initFrames[1]!.at!)
        .map((f) => Number(f.data!.split(" ")[2])),
    );
    const inLedger = filledPicks(decode(1)).map((p) => p.playerId);
    const recovered = inLedger.filter((p) => !seen.has(p));
    expect(seen.size).toBe(27);
    expect(inLedger).toHaveLength(29);
    expect(recovered).toHaveLength(2);
  });

  it("preserves negative player ids (D/ST) rather than treating them as empty", () => {
    // Only -1 is the empty sentinel. D/ST ids sit near -16000.
    const bytes = new Uint8Array(RECORD_STRIDE * 12);
    const view = new DataView(bytes.buffer);
    for (let n = 0; n < 12; n++) {
      view.setInt32(n * RECORD_STRIDE + 4, n + 1);
      view.setInt32(n * RECORD_STRIDE + 8, n === 3 ? -16007 : -1);
      view.setInt32(n * RECORD_STRIDE, 5);
    }
    const picks = filledPicks(decodeLedger(bytes));
    expect(picks).toHaveLength(1);
    expect(picks[0]!.playerId).toBe(-16007);
  });

  it("carries the unresolved third field opaquely without interpreting it", () => {
    const picks = filledPicks(decode(1));
    expect(picks.every((p) => Number.isInteger(p.slot3))).toBe(true);
  });

  it("throws rather than reading past the end of a truncated blob", () => {
    const full = Buffer.from(initFrames[1]!.data!.slice(5).trim(), "base64");
    expect(() => decodeLedger(new Uint8Array(full.subarray(0, 40)))).toThrow(LedgerFormatError);
  });

  it("fails loudly when no pick array is present, rather than returning nothing", () => {
    expect(() => decodeLedger(new Uint8Array(4000))).toThrow(/layout may have changed/);
  });

  it("ignores frames that are not INIT", () => {
    expect(decodeInitFrame("SELECTED 5 4429795 2\n", nodeAtob)).toBeNull();
  });
});
