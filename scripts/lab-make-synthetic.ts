// 008 T014 — generate the synthetic corpus entry.
//
//   npx tsx scripts/lab-make-synthetic.ts
//
// A COMMITTED GENERATOR rather than hand-typed JSON, for one reason: the
// fixture must satisfy the codec, and a hand-typed file drifts from the shape
// the moment a field is added. Running this regenerates it exactly.
//
// It is SYNTHETIC on purpose. Every identifier is invented, so it can be
// committed with no screening question at all, and it lets US1–US4 be tested
// without D1, without ESPN, and without waiting for a real draft. It is
// classified `test`, so it can never contaminate a rule-set comparison — a
// synthetic room is even less like a real one than a mock draft is.
//
// 6 teams × 3 rounds = 18 picks, snake order, one D/ST taken (negative id) and
// one player deliberately absent from the board.

import { writeFileSync } from "node:fs";
import { bundleToSnapshot, canonicalJson } from "../src/lab/codec";
import { CORPUS_FORMAT_VERSION, type CorpusEntry, type CorpusPick } from "../src/lab/corpus";
import type { EngineBundle, SignalKind, SignalValue } from "../src/engine/types";
import type { BoardEntry } from "../src/projections/scoring";

const TEAMS = 6;
const ROUNDS = 3;
const TOTAL = TEAMS * ROUNDS;
const ORDER = [3, 1, 5, 2, 6, 4]; // arbitrary, and NOT 1..6 — so a bug that
// assumes the identity order is visible rather than accidentally correct.
const MY_TEAM = 5;
/**
 * The owner's turns, worked out from ORDER rather than assumed.
 *
 * Round 1 (odd) runs 3,1,5,2,6,4 → owner at overall 3.
 * Round 2 (even) runs 4,6,2,5,1,3 → owner at overall 10.
 * Round 3 (odd) runs 3,1,5,2,6,4 → owner at overall 15.
 */
const OWNER_OFF_BOARD_TURN = 15;

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const TEAM_ABBR = ["SF", "KC", "BUF", "DAL", "PHI", "CIN", "DET", "MIA"];

/** 24 board players, deterministic and obviously invented. */
function board(): BoardEntry[] {
  const out: BoardEntry[] = [];
  for (let i = 0; i < 24; i++) {
    const pos = POSITIONS[i % POSITIONS.length]!;
    const isDst = pos === "DST";
    out.push({
      // A NAMESPACE REAL ESPN IDS CANNOT REACH. The first version used
      // `2000 + i` and `-16000 - i` — and `-16000 - i` is *exactly* ESPN's
      // D/ST scheme, so every synthetic defence was a real defence. A genuine
      // 2025 import then "matched" two of them, and `lab-behaviour.ts` reported
      // a standard deviation of 27 from those two accidental collisions, with
      // an arrow labelling it the opponent model's noise parameter.
      //
      // Real ids observed: positive 8,439 – 5,081,397; D/ST at −16,000 − teamId.
      // 900,000,000+ is unreachable from both. The negative id is KEPT (just
      // moved) because "never filter on sign" needs a negative case to test.
      espn_player_id: isDst ? -900_000_000 - i : 900_000_000 + i,
      name: isDst ? `${TEAM_ABBR[i % TEAM_ABBR.length]} D/ST` : `Synthetic Player ${i + 1}`,
      position: pos,
      eligible_positions: [pos],
      team: TEAM_ABBR[i % TEAM_ABBR.length]!,
      bye_week: 5 + (i % 8),
      projected_points: Math.round((260 - i * 7.5) * 10) / 10,
      position_rank: Math.floor(i / POSITIONS.length) + 1,
      adp: i + 1,
      overall_rank: i + 1,
    });
  }
  return out;
}

function signalValue(rank: number): SignalValue {
  return {
    raw_value: 400 - rank * 5,
    score: Math.round((100 - rank * 3) * 10) / 10,
    rank,
    provenance: "synthetic",
    computed_at: "2026-08-04T00:00:00.000Z",
  };
}

function bundle(players: BoardEntry[]): EngineBundle {
  const signals = new Map<SignalKind, Map<number, SignalValue>>();
  const offense = new Map<number, SignalValue>();
  const sos = new Map<number, SignalValue>();
  for (let t = 1; t <= 8; t++) {
    offense.set(t, signalValue(t));
    sos.set(t, signalValue(9 - t));
  }
  signals.set("offense", offense);
  signals.set("sos", sos);
  // `oline` is deliberately ABSENT, not empty: the engine distinguishes "no
  // signal" from "a signal of zero" and says so in its explanation.

  return {
    players,
    signals,
    proTeamByPlayer: new Map(
      players.map((p, i) => [p.espn_player_id, (i % 8) + 1] as [number, number]),
    ),
    // DELIBERATELY SMALL. A 3-round draft against 8 mandatory starting slots
    // makes every single turn `forced` — the engine stops choosing and starts
    // filling, so the fixture would exercise the degenerate path and nothing
    // else. Two mandatory slots over three rounds leaves the engine actually
    // ranking for the first two turns and forced for the last, which is the
    // mix worth having.
    roster: {
      slots: [
        { slotId: 0, label: "QB", count: 1 },
        { slotId: 2, label: "RB", count: 1 },
        { slotId: 20, label: "BE", count: 1 },
      ],
      starting_slots: 2,
      bench_slots: 1,
    },
    teamCount: TEAMS,
    preferred: new Set<number>([900_000_002]),
    adpFloor: null,
    freshness: { fetchedAt: "2026-08-04T13:00:00.000Z", stale: false },
    signalFreshness: new Map([
      ["offense", { computedAt: "2026-08-04T00:00:00.000Z", provenance: "synthetic" }],
      ["sos", { computedAt: "2026-08-04T00:00:00.000Z", provenance: "synthetic" }],
    ]),
  };
}

function picks(players: BoardEntry[]): CorpusPick[] {
  const out: CorpusPick[] = [];
  for (let overall = 1; overall <= TOTAL; overall++) {
    const round = Math.ceil(overall / TEAMS);
    const idx = (overall - 1) % TEAMS;
    // Snake, derived from the ROUND. Never from a field on the pick — 010's
    // oracle disproved the field-3-is-the-round reading at 5 of 70.
    const seat = round % 2 === 1 ? idx : TEAMS - 1 - idx;
    const playerId =
      // Overall 15 is one of the OWNER's turns (order [3,1,5,2,6,4], owner is
      // team 5, so the owner holds 3, 10 and 15). It takes a player who is not
      // on the board at all — obscure, released, or outside the serving set.
      //
      // Putting it on an owner turn is the whole point: an off-board pick that
      // lands on someone else's turn never reaches `TurnObservation`, so the
      // path FR-005 exists for would go untested. An earlier version of this
      // generator used overall 17, which belongs to team 6.
      overall === OWNER_OFF_BOARD_TURN ? 999_999_999 : players[overall - 1]!.espn_player_id;
    out.push({
      overall,
      round,
      roundPick: idx + 1,
      teamId: ORDER[seat]!,
      playerId,
      keeper: false,
      autodrafted: overall > 15,
      observedAt: new Date(Date.UTC(2026, 7, 4, 23, overall)).toISOString(),
      observedEpoch: 1,
    });
  }
  return out;
}

const players = board();
const entry: CorpusEntry = {
  formatVersion: CORPUS_FORMAT_VERSION,
  id: "synthetic-2026",
  season: 2026,
  espnLeagueId: "1111111111",
  provenance: "live_frames",
  // TEST, always. A synthetic room is even less like a real one than a mock
  // draft, so this must never reach a rule-set comparison.
  provenanceClass: "test",
  useClass: "replayable",
  unreplayableReason: null,
  teamCount: TEAMS,
  roundCount: ROUNDS,
  totalPicks: TOTAL,
  myTeamId: MY_TEAM,
  order: ORDER,
  picks: picks(players),
  keepers: [],
  startedAt: "2026-08-04T23:00:00.000Z",
  completedAt: "2026-08-04T23:45:00.000Z",
  oracle: null,
  gaps: [],
};

const snapshot = bundleToSnapshot(bundle(players), {
  entryId: entry.id,
  sourceSetId: "synthetic-set",
  sourceSetFetchedAt: "2026-08-04T13:00:00.000Z",
});

const dir = "tests/fixtures/lab";
writeFileSync(`${dir}/synthetic-2026.draft.json`, canonicalJson(entry));
writeFileSync(`${dir}/synthetic-2026.inputs.json`, canonicalJson(snapshot));
console.log(`wrote ${dir}/synthetic-2026.{draft,inputs}.json — ${TOTAL} picks, ${players.length} players`);
