// 006 T032/T039/T054/T055 — the engine over a real draft, offline.
//
// SC-001  every state ranks only available players
// SC-002  every shortlist head entry is explained
// SC-009  the whole replay runs with NO network available
// SC-010  the same pick history yields the same advice, from the archive alone
// SC-014  every entry's adjustments reconcile to its value delta
//
// THE CORPUS IS THE REAL ONE: 72 picks from an actual draft, which 005's replay
// proved agrees with ESPN's independent post-draft record on all 72.
//
// AND THE HARNESS ASSERTS IT ACTUALLY RAN. 005 shipped an SC-010 test that was
// structurally blind — it passed while proving nothing, because its fixtures
// could not express the failure it was meant to catch. A replay that silently
// walks zero states looks exactly like a replay that walks seventy-two, so the
// state count is asserted explicitly.

import { fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import oracleJson from "../fixtures/tap/oracle-live-2026.json";
import { recommend } from "../../src/engine/recommend";
import { reconciles } from "../../src/engine/explain";
import { deriveState } from "../../src/engine/state";
import { makeBundle, ORDER, playerInfoFrom, TEAM_COUNT } from "./helpers";
import type { EngineBundle, EngineState } from "../../src/engine/types";
import { boardEntry } from "./helpers";

interface OraclePick {
  overallPickNumber: number;
  teamId: number;
  playerId: number;
}
const ORACLE = oracleJson as unknown as { pick_count: number; picks: OraclePick[] };

/**
 * A board containing every player the real draft actually took, plus enough
 * undrafted depth that the pool never empties.
 *
 * Built from the corpus rather than invented: a replay whose board does not
 * contain the drafted players would remove nothing and prove nothing.
 */
function corpusBundle(): EngineBundle {
  const positions = ["RB", "WR", "TE", "QB", "K", "DST"];
  const drafted = ORACLE.picks.map((p, i) =>
    boardEntry({
      id: p.playerId,
      position: positions[i % positions.length]!,
      points: 250 - i * 1.5,
      // ESPN's real shape: informative for a while, then the floor.
      adp: i < 60 ? i + 1.4 : 169.9 + (i % 15) * 0.01,
      bye: 5 + (i % 9),
      proTeam: 1 + (i % 32),
      name: `Drafted ${p.playerId}`,
    }),
  );
  const filler = Array.from({ length: 260 }, (_, i) =>
    boardEntry({
      id: 800_000 + i,
      position: positions[i % positions.length]!,
      points: 140 - i * 0.4,
      adp: i < 110 ? 62 + i : 169.9 + (i % 15) * 0.01,
      bye: 5 + (i % 9),
      proTeam: 1 + (i % 32),
      name: `Filler ${i}`,
    }),
  );
  const players = [...drafted, ...filler];
  const bundle = makeBundle({ players });
  bundle.proTeamByPlayer = new Map(players.map((p) => [p.espn_player_id, Number(p.team.slice(1)) || 1]));
  return bundle;
}

/** The state after the first `n` picks of the real draft. */
function stateAfter(bundle: EngineBundle, n: number): EngineState {
  const picks = ORACLE.picks.slice(0, n).map((p) => ({
    overall: p.overallPickNumber,
    teamId: p.teamId,
    playerId: p.playerId,
  }));
  return deriveState({
    revision: 1,
    picks,
    order: ORDER,
    myTeamId: ORACLE.picks[0]!.teamId,
    totalPicks: ORACLE.pick_count,
    keepers: new Map(),
    playerInfo: playerInfoFrom(bundle.players),
    withholding: null,
  });
}

let bundle: EngineBundle;

beforeAll(() => {
  bundle = corpusBundle();
});

describe("the corpus is real and complete", () => {
  it("has 72 picks, the draft 005's replay verified against ESPN", () => {
    expect(ORACLE.pick_count).toBe(72);
    expect(ORACLE.picks).toHaveLength(72);
  });

  it("contains a NEGATIVE player id — D/ST, which sign filtering would drop", () => {
    // 010's capture reported 66 of 72 because `playerId > 0` removed exactly
    // these. If this stops being true the corpus has been replaced with a
    // sanitised one and the replay has lost its teeth.
    expect(ORACLE.picks.some((p) => p.playerId < 0)).toBe(true);
  });
});

describe("SC-001 / SC-002 / SC-014 — every state of a real draft", () => {
  it("walks all 72 states and satisfies every per-state invariant", () => {
    // NO NETWORK (SC-009). Any outbound request throws, for the whole replay.
    fetchMock.activate();
    fetchMock.disableNetConnect();

    let statesVisited = 0;
    let entriesChecked = 0;
    let explanationsChecked = 0;

    for (let n = 0; n <= ORACLE.pick_count; n++) {
      const state = stateAfter(bundle, n);
      const board = recommend(bundle, state);
      statesVisited++;

      // SC-001 — only available players are ranked.
      for (const e of board.entries) {
        expect(state.drafted.has(e.playerId), `pick ${n}: ${e.playerId} was already taken`).toBe(false);
        entriesChecked++;
      }
      // Nobody available is missing either — totality (FR-001).
      expect(board.entries).toHaveLength(bundle.players.length - state.drafted.size);

      // SC-002 — every head entry explained, naming value and alternatives.
      for (const s of board.shortlist) {
        expect(s.explanation, `pick ${n}: ${s.playerId} unexplained`).toBeDefined();
        expect(typeof s.explanation.rawValue).toBe("number");
        expect(Array.isArray(s.explanation.alternatives)).toBe(true);

        // SC-014 — the parts add up. Checked for EVERY head entry at EVERY
        // state, not sampled.
        expect(reconciles(s.explanation), `pick ${n}: ${s.playerId} does not reconcile`).toBe(true);
        explanationsChecked++;
      }
    }

    // THE HARNESS RAN. Without this a broken loop passes silently.
    expect(statesVisited).toBe(73); // 0 picks made through 72
    expect(entriesChecked).toBeGreaterThan(20_000);
    expect(explanationsChecked).toBeGreaterThan(300);

    fetchMock.assertNoPendingInterceptors();
  });
});

describe("SC-010 — reproducible from the pick history alone", () => {
  it("gives identical advice for the same history, every time", () => {
    for (const n of [0, 1, 11, 12, 36, 71, 72]) {
      const a = recommend(bundle, stateAfter(bundle, n));
      const b = recommend(bundle, stateAfter(bundle, n));
      expect(JSON.stringify(a), `pick ${n}`).toBe(JSON.stringify(b));
    }
  });

  it("gives DIFFERENT advice as the history grows — the replay is not inert", () => {
    // The other half. A replay that returned the same board at every state
    // would satisfy the test above perfectly.
    const shapes = new Set([0, 12, 36, 60].map((n) => JSON.stringify(recommend(bundle, stateAfter(bundle, n)))));
    expect(shapes.size).toBe(4);
  });
});

describe("T055 — the three states the rules are most likely to get wrong", () => {
  it("the SNAKE TURNAROUND: a gap of one pick, not a round", () => {
    // Back-to-back picks. Nothing may be treated as safely surviving.
    const state = stateAfter(bundle, TEAM_COUNT - 1);
    const backToBack: EngineState = { ...state, gapToNextTurn: 1 };
    const roundAway: EngineState = { ...state, gapToNextTurn: TEAM_COUNT * 2 };

    const survivalMass = (s: EngineState): number =>
      recommend(bundle, s)
        .shortlist.flatMap((x) => x.explanation.adjustments)
        .filter((a) => a.rule === "survival")
        .reduce((sum, a) => sum + a.magnitude, 0);

    expect(survivalMass(backToBack)).toBeLessThan(survivalMass(roundAway));
  });

  it("the FINAL PICK: no next turn, so survival does not apply (FR-023)", () => {
    const state: EngineState = { ...stateAfter(bundle, 71), gapToNextTurn: null };
    const board = recommend(bundle, state);
    const rules = board.shortlist.flatMap((s) => s.explanation.adjustments.map((a) => a.rule));
    expect(rules).not.toContain("survival");
    // …and its absence is NOT reported as a missing input.
    const missing = board.shortlist.flatMap((s) => s.explanation.missing.map((m) => m.input));
    expect(missing).not.toContain("survival");
    // The board is still produced, and still explained.
    expect(board.shortlist.length).toBeGreaterThan(0);
    expect(board.shortlist.every((s) => reconciles(s.explanation))).toBe(true);
  });

  it("the LATE ROUNDS: nearly every ADP is floored, so no survival claim is made", () => {
    // The failure this prevents: ranking two thirds of the board as safely
    // lasting, most confidently in exactly the rounds where it is least true.
    const floored = bundle.players.filter((p) => p.adp !== null && p.adp >= (bundle.adpFloor ?? Infinity));
    expect(floored.length, "fixture must actually contain a floor").toBeGreaterThan(50);

    const state = stateAfter(bundle, 66);
    const board = recommend(bundle, state);
    for (const s of board.shortlist) {
      const isFloored = floored.some((p) => p.espn_player_id === s.playerId);
      if (!isFloored) continue;
      expect(
        s.explanation.adjustments.map((a) => a.rule),
        `${s.playerId} is at the ADP floor and must carry no survival claim`,
      ).not.toContain("survival");
      expect(s.explanation.missing.map((m) => m.input)).toContain("adp");
    }
  });
});

describe("robustness over the real corpus", () => {
  it("never emits a NaN or a non-finite value at any state", () => {
    for (let n = 0; n <= ORACLE.pick_count; n += 6) {
      const board = recommend(bundle, stateAfter(bundle, n));
      expect(Number.isFinite(board.roundValue)).toBe(true);
      for (const e of board.entries) {
        expect(Number.isFinite(e.rawValue), `pick ${n}, player ${e.playerId}`).toBe(true);
        expect(Number.isFinite(e.finalValue), `pick ${n}, player ${e.playerId}`).toBe(true);
      }
    }
  });

  it("keeps ranks contiguous at every state", () => {
    for (let n = 0; n <= ORACLE.pick_count; n += 9) {
      const board = recommend(bundle, stateAfter(bundle, n));
      expect(board.entries.map((e) => e.rank)).toEqual(
        Array.from({ length: board.entries.length }, (_, i) => i + 1),
      );
    }
  });
});
