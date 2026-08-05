// 010 T047 — the committed corpus, captured by the SHIPPED tap from a real
// live draft and exported from what the ingest retained.
//
// This is the artifact 005 was blocked on: it lets the reconciler be built and
// tested with no browser and no draft.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Msg {
  v: number; seq: number; epoch: number; observedAt: string;
  transport: "ws" | "sse"; kind: "pick" | "ledger" | "status";
  payload: { teamId: number; playerId: number; slot3: number } | { playerId: number; teamId: number }[];
}

const msgs = readFileSync("tests/fixtures/tap/replay-full.jsonl", "utf8")
  .trim().split("\n").map((l) => JSON.parse(l) as Msg);
const picks = msgs.filter((m) => m.kind === "pick");
const ledgers = msgs.filter((m) => m.kind === "ledger");

/** ESPN's own post-draft record for the SAME draft, fetched independently of
 *  the tap (FR-019b). Without it the corpus would only be checked against
 *  itself, which proves nothing. */
const oracle = JSON.parse(readFileSync("tests/fixtures/tap/oracle-live-2026.json", "utf8")) as {
  pick_count: number;
  picks: { overallPickNumber: number; teamId: number; playerId: number }[];
};

describe("live-draft corpus", () => {
  it("covers a whole draft", () => {
    expect(picks.length).toBeGreaterThan(50);
    expect(ledgers.length).toBeGreaterThan(0);
  });

  it("the ledger recovers picks the incremental stream never delivered", () => {
    // Observed on TWO separate live drafts now. The incremental stream is
    // lossy; the ledger is what makes FR-005/FR-012 non-negotiable.
    const fromPicks = new Set(picks.map((m) => (m.payload as { playerId: number }).playerId));
    const fromLedger = new Set(
      ledgers.flatMap((m) => (m.payload as { playerId: number }[]).map((p) => p.playerId)),
    );
    const recovered = [...fromLedger].filter((p) => !fromPicks.has(p));
    expect(recovered.length).toBeGreaterThan(0);
    // Together they account for every slot in a 6-team, 12-round draft.
    expect(new Set([...fromPicks, ...fromLedger]).size).toBe(72);
  });

  it("preserves D/ST picks (negative player ids) end to end", () => {
    const negative = picks.filter((m) => (m.payload as { playerId: number }).playerId < 0);
    expect(negative.length).toBe(6);
  });

  it("is ordered and single-epoch, so 005 can treat it as one timeline", () => {
    expect(msgs.map((m) => m.seq)).toEqual(msgs.map((_, i) => i));
    expect(new Set(msgs.map((m) => m.epoch)).size).toBe(1);
  });

  it("carries the ledger BEFORE any incremental pick, per FR-005", () => {
    expect(msgs[0]!.kind).toBe("ledger");
  });

  it("agrees with ESPN's independent post-draft record, exactly", () => {
    const fromTap = new Set([
      ...picks.map((m) => (m.payload as { playerId: number }).playerId),
      ...ledgers.flatMap((m) => (m.payload as { playerId: number }[]).map((p) => p.playerId)),
    ]);
    const fromEspn = new Set(oracle.picks.map((p) => p.playerId));
    expect(oracle.pick_count).toBe(72);
    expect([...fromTap].filter((p) => !fromEspn.has(p))).toEqual([]);
    expect([...fromEspn].filter((p) => !fromTap.has(p))).toEqual([]);
  });

  it("assigns every pick to the team ESPN says drafted it", () => {
    const byPlayer = new Map(oracle.picks.map((p) => [p.playerId, p]));
    for (const m of picks) {
      const p = m.payload as { playerId: number; teamId: number };
      expect(p.teamId, `player ${p.playerId}`).toBe(byPlayer.get(p.playerId)!.teamId);
    }
  });

  it("the ledger's pick ordinals match ESPN's, so the decoder is right", () => {
    const byPlayer = new Map(oracle.picks.map((p) => [p.playerId, p]));
    const entries = ledgers.flatMap((m) => m.payload as { playerId: number; overallPickNumber: number }[]);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.overallPickNumber, `player ${e.playerId}`).toBe(byPlayer.get(e.playerId)!.overallPickNumber);
    }
  });

  it("contains no identifier and no URL", () => {
    const blob = JSON.stringify(msgs);
    expect(blob).not.toMatch(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/);
    expect(blob).not.toContain("http");
  });
});
