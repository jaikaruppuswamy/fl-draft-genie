// 005 T048/T049 — the completion oracle.
//
// Run against the REAL corpus and the REAL post-draft record, because that
// pairing is the whole value: the two were produced by different mechanisms,
// so agreement means something. In 010 this same comparison disproved the
// field-3 reading (5/70) and confirmed the ledger offsets (31/31).

import { describe, expect, it } from "vitest";
import corpusRaw from "../fixtures/tap/replay-full.jsonl?raw";
import oracleJson from "../fixtures/tap/oracle-live-2026.json";
import { compareToOracle, isClean, reconciledPicks } from "../../src/draft/oracle";
import { initialState, reconcile, type Pick } from "../../src/draft/reconcile";
import type { Observation, PickObservation } from "../../src/draft/feed";
import type { CompletedPick } from "../../src/espn/parsers";

interface OracleRow {
  overallPickNumber: number;
  roundId: number;
  roundPickNumber: number;
  teamId: number;
  playerId: number;
  keeper: boolean;
  autoDraftTypeId: number;
}

const rows = (oracleJson as unknown as { picks: OracleRow[] }).picks;
const espn: CompletedPick[] = rows.map((r) => ({
  overall: r.overallPickNumber,
  round: r.roundId,
  roundPick: r.roundPickNumber,
  teamId: r.teamId,
  playerId: r.playerId,
  keeper: r.keeper,
  autodrafted: r.autoDraftTypeId > 0,
}));

/** The draft as the tap actually delivered it. */
function tapBuiltDraft(): Pick[] {
  const corpus = (corpusRaw as string)
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { seq: number; kind: string; payload: unknown });
  const order = [...rows].sort((a, b) => a.overallPickNumber - b.overallPickNumber).slice(0, 6).map((p) => p.teamId);
  let state = initialState({ order, myTeamId: 1, totalPicks: 72 });
  for (const m of corpus) {
    const obs: Observation = { picks: [], ledger: null, statuses: [], cursor: { receivedAt: "", id: "" } };
    const at = `2026-08-05T02:${String(m.seq).padStart(2, "0")}:00.000Z`;
    if (m.kind === "pick") {
      obs.picks = [{ ...(m.payload as PickObservation), observedAt: at, epoch: 0 }];
    } else if (m.kind === "ledger") {
      obs.ledger = (m.payload as PickObservation[]).map((r) => ({ ...r, observedAt: at, epoch: 0 }));
    }
    state = reconcile(state, obs).state;
  }
  return state.picks;
}

describe("the tap-built draft vs ESPN's own record", () => {
  it("agrees COMPLETELY on the real corpus", () => {
    // If this ever fails, either the tap changed or the reducer did — and the
    // oracle is the thing that can tell us, because it did not produce the
    // data it is checking.
    const d = compareToOracle(tapBuiltDraft(), espn);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
    expect(d.mismatched).toEqual([]);
    expect(isClean(d)).toBe(true);
    expect(d.ourCount).toBe(72);
    expect(d.espnCount).toBe(72);
  });

  it("needs no correction when the two agree", () => {
    expect(reconciledPicks(tapBuiltDraft(), espn)).toBeNull();
  });
});

describe("compareToOracle", () => {
  const ours = tapBuiltDraft();

  it("reports a pick the tap MISSED — the serious direction", () => {
    const d = compareToOracle(ours.slice(0, 71), espn);
    expect(d.missing).toHaveLength(1);
    expect(d.missing[0]!.playerId).toBe(espn.at(-1)!.playerId);
  });

  it("reports a pick the tap invented", () => {
    const bogus: Pick = { overall: 73, teamId: 1, playerId: 999999, slot3: 0, observedAt: "x", epoch: 0 };
    const d = compareToOracle([...ours, bogus], espn);
    expect(d.extra.map((e) => e.playerId)).toEqual([999999]);
  });

  it("localises a MOVED pick to one mismatch, not a cascade", () => {
    // Comparing by position would report every pick after an off-by-one as
    // wrong, burying the real defect in noise. Identity keeps it to one row.
    const moved = ours.map((p, i) => (i === 10 ? { ...p, overall: p.overall + 1 } : p));
    const d = compareToOracle(moved, espn);
    expect(d.mismatched).toHaveLength(1);
    expect(d.mismatched[0]!.playerId).toBe(ours[10]!.playerId);
  });

  it("catches a pick attributed to the wrong TEAM", () => {
    const wrongTeam = ours.map((p, i) => (i === 5 ? { ...p, teamId: p.teamId === 1 ? 2 : 1 } : p));
    const d = compareToOracle(wrongTeam, espn);
    expect(d.mismatched).toHaveLength(1);
  });

  it("handles D/ST negatives without treating them as sentinels", () => {
    const negatives = espn.filter((e) => e.playerId < 0);
    expect(negatives.length).toBeGreaterThan(0);
    const d = compareToOracle(ours, espn);
    expect(d.missing.filter((m) => m.playerId < 0)).toEqual([]);
  });
});

describe("reconciledPicks", () => {
  const ours = tapBuiltDraft();

  it("adopts ESPN's record where they disagree", () => {
    const short = ours.slice(0, 70);
    const fixed = reconciledPicks(short, espn)!;
    expect(fixed).toHaveLength(72);
    expect(compareToOracle(fixed, espn).missing).toEqual([]);
  });

  it("PRESERVES our observation times — ESPN's flush stamp would flatten them", () => {
    // ESPN writes the whole draft at completion, so every row shares one
    // timestamp. Adopting it would destroy the per-pick timing 008 needs.
    const moved = ours.map((p, i) => (i === 3 ? { ...p, teamId: p.teamId + 50 } : p));
    const fixed = reconciledPicks(moved, espn)!;
    const restored = fixed.find((p) => p.playerId === ours[3]!.playerId)!;
    expect(restored.observedAt).toBe(ours[3]!.observedAt);
    expect(new Set(fixed.map((p) => p.observedAt)).size).toBeGreaterThan(1);
  });

  it("refuses to reconcile against an EMPTY record", () => {
    // ESPN returning nothing is a failed read, not a draft with no picks.
    // Adopting it would erase the entire draft.
    expect(reconciledPicks(ours, [])).toBeNull();
  });
});
