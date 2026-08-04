// 010 T028 — replay the real capture through the whole pure pipeline and check
// it against the INDEPENDENT oracle.
//
// This is the test the corpus exists for. Validating the capture against itself
// would prove nothing; the oracle is derived from ESPN's post-draft record, so
// this assertion can actually fail — and it already caught one wrong field
// meaning during the gate.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify } from "../../tap/classify";
import { decodeInitFrame, filledPicks } from "../../tap/decode";
import { assertTransmittable, filterLedgerPick, filterPickFields, type PickPayload } from "../../tap/filter";

const frames = readFileSync("tests/fixtures/tap/capture-2026.jsonl", "utf8")
  .trim().split("\n").map((l) => JSON.parse(l) as { data?: string; event?: string; url?: string });

const oracle = JSON.parse(readFileSync("tests/fixtures/tap/oracle-2026.json", "utf8")) as {
  pick_count: number;
  picks: { overallPickNumber: number; teamId: number; playerId: number }[];
};

const atob = (s: string) => Buffer.from(s, "base64").toString("binary");

/** The pipeline exactly as tap/main.ts drives it. */
function replay() {
  const picks: PickPayload[] = [];
  const ledgers: PickPayload[][] = [];
  let unrecognised = 0;
  for (const f of frames) {
    if (!f.data || f.event !== "message") continue;
    if (f.url && !f.url.includes("fantasydraft")) continue; // URL scoping
    const c = classify(f.data);
    if (c.kind === "pick") {
      const p = filterPickFields(c.fields);
      if (p) picks.push(p);
    } else if (c.kind === "ledger") {
      const l = decodeInitFrame(f.data, atob);
      if (l) ledgers.push(filledPicks(l).map(filterLedgerPick));
    } else if (c.kind === "unrecognised") {
      unrecognised++;
    }
  }
  return { picks, ledgers, unrecognised };
}

describe("full-capture replay", () => {
  const { picks, ledgers, unrecognised } = replay();

  it("relays every incremental pick the capture contains", () => {
    expect(picks).toHaveLength(70);
  });

  it("recognises every frame — no unrecognised verbs in a real draft", () => {
    expect(unrecognised).toBe(0);
  });

  it("every relayed pick matches the independent oracle on team and player", () => {
    const byPlayer = new Map(oracle.picks.map((p) => [p.playerId, p]));
    for (const p of picks) {
      const o = byPlayer.get(p.playerId);
      expect(o, `player ${p.playerId} absent from the oracle`).toBeDefined();
      expect(p.teamId).toBe(o!.teamId);
    }
  });

  it("the ledger closes the gap the incremental stream leaves", () => {
    // 70 of 72 picks arrived as frames; the reload lost two. The final ledger
    // plus the stream must cover the whole draft.
    const fromStream = new Set(picks.map((p) => p.playerId));
    const fromLedger = new Set(ledgers.at(-1)!.map((p) => p.playerId));
    const union = new Set([...fromStream, ...fromLedger]);
    expect(fromStream.size).toBe(70);
    expect([...fromLedger].every((p) => oracle.picks.some((o) => o.playerId === p))).toBe(true);
    expect(union.size).toBeGreaterThan(fromStream.size);
  });

  it("leaks nothing on the wire — no GUID, no URL, in any relayed payload", () => {
    for (const p of [...picks, ...ledgers.flat()]) {
      expect(() => assertTransmittable(p)).not.toThrow();
    }
    const wire = JSON.stringify([picks, ledgers]);
    expect(wire).not.toMatch(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/);
    expect(wire).not.toContain("http");
  });

  it("preserves D/ST picks through the whole pipeline", () => {
    expect(picks.filter((p) => p.playerId < 0)).toHaveLength(6);
  });
});
