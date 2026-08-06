// 008 — fixture builders for the lab suite.
//
// Hand-built rather than loaded, so a test that cares about ONE field can set
// that field and inherit the rest. The committed fixtures exist to prove the
// real shapes load; these exist to make invariants testable one at a time.

import type { CorpusEntry, CorpusPick } from "../../src/lab/corpus";
import { CORPUS_FORMAT_VERSION } from "../../src/lab/corpus";
import type { EngineBundle, SignalKind, SignalValue } from "../../src/engine/types";
import type { BoardEntry } from "../../src/projections/scoring";

export function pick(over: Partial<CorpusPick> & { overall: number }): CorpusPick {
  const teams = 6;
  const round = Math.ceil(over.overall / teams);
  const idx = (over.overall - 1) % teams;
  // Snake: even rounds run right to left. Derived from the ROUND, never from a
  // field on the pick — 010's oracle disproved the field-3-is-the-round reading
  // at 5 of 70.
  const roundPick = round % 2 === 1 ? idx + 1 : teams - idx;
  return {
    round,
    roundPick,
    teamId: round % 2 === 1 ? idx + 1 : teams - idx,
    playerId: 1000 + over.overall,
    keeper: false,
    autodrafted: false,
    observedAt: null,
    observedEpoch: null,
    ...over,
  };
}

export function entry(over: Partial<CorpusEntry> = {}): CorpusEntry {
  const totalPicks = over.totalPicks ?? 12;
  const picks = over.picks ?? Array.from({ length: totalPicks }, (_, i) => pick({ overall: i + 1 }));
  return {
    formatVersion: CORPUS_FORMAT_VERSION,
    id: "test-2026",
    season: 2026,
    espnLeagueId: "9999999999",
    provenance: "live_frames",
    provenanceClass: "real",
    useClass: "replayable",
    unreplayableReason: null,
    teamCount: 6,
    roundCount: 2,
    totalPicks,
    myTeamId: 1,
    order: [1, 2, 3, 4, 5, 6],
    picks,
    keepers: [],
    startedAt: "2026-08-04T23:00:00.000Z",
    completedAt: "2026-08-04T23:45:00.000Z",
    oracle: null,
    gaps: [],
    ...over,
  };
}

export function boardEntry(over: Partial<BoardEntry> & { espn_player_id: number }): BoardEntry {
  return {
    name: `Player ${over.espn_player_id}`,
    position: "RB",
    eligible_positions: ["RB"],
    team: "SF",
    bye_week: 9,
    projected_points: 100,
    position_rank: 1,
    adp: 10,
    overall_rank: 1,
    ...over,
  };
}

export function signal(over: Partial<SignalValue> = {}): SignalValue {
  return {
    raw_value: 400,
    score: 75,
    rank: 8,
    provenance: "derived:projections@2026-08-04T00:00:00.000Z",
    computed_at: "2026-08-04T00:00:00.000Z",
    ...over,
  };
}

/**
 * A minimal but REAL EngineBundle — the engine is called unmodified, so a
 * stub-shaped bundle would only prove the stub works.
 */
export function bundle(over: Partial<EngineBundle> = {}): EngineBundle {
  // The board must be LARGER than the draft it is used with. An earlier version
  // held 8 players against a 12-pick draft, so both of the owner's turns drafted
  // someone who was not on the board — and every "off-board" assertion passed
  // for the wrong reason. A real board has hundreds of players and a draft takes
  // a fraction of them; the fixture should have the same shape.
  const players: BoardEntry[] = over.players ?? [
    boardEntry({ espn_player_id: 1001, name: "Ash Rivers", position: "RB", projected_points: 220, adp: 1 }),
    boardEntry({ espn_player_id: 1002, name: "Bo Canyon", position: "WR", projected_points: 210, adp: 2 }),
    boardEntry({ espn_player_id: 1003, name: "Cy Meadow", position: "QB", projected_points: 200, adp: 3 }),
    boardEntry({ espn_player_id: 1004, name: "Dee Harbor", position: "TE", projected_points: 190, adp: 4 }),
    boardEntry({ espn_player_id: 1005, name: "El Ridge", position: "RB", projected_points: 180, adp: 5 }),
    boardEntry({ espn_player_id: 1006, name: "Fi Grove", position: "WR", projected_points: 170, adp: 6 }),
    boardEntry({ espn_player_id: 1007, name: "Gus Hollow", position: "K", projected_points: 160, adp: 7 }),
    boardEntry({ espn_player_id: 1008, name: "Hal Bluff", position: "RB", projected_points: 150, adp: 8 }),
    boardEntry({ espn_player_id: 1009, name: "Ivy Creek", position: "WR", projected_points: 140, adp: 9 }),
    boardEntry({ espn_player_id: 1010, name: "Jo Prairie", position: "TE", projected_points: 130, adp: 10 }),
    boardEntry({ espn_player_id: 1011, name: "Kit Basin", position: "QB", projected_points: 120, adp: 11 }),
    boardEntry({ espn_player_id: 1012, name: "Lou Summit", position: "RB", projected_points: 110, adp: 12 }),
    boardEntry({ espn_player_id: 1013, name: "Mo Delta", position: "WR", projected_points: 100, adp: 13 }),
    boardEntry({ espn_player_id: 1014, name: "Nan Fjord", position: "K", projected_points: 90, adp: 14 }),
    boardEntry({ espn_player_id: -16001, name: "Bears D/ST", position: "DST", projected_points: 80, adp: 15 }),
  ];
  const signals = new Map<SignalKind, Map<number, SignalValue>>([
    ["offense", new Map([[25, signal()]])],
  ]);
  return {
    players,
    signals,
    proTeamByPlayer: new Map(players.map((p) => [p.espn_player_id, 25])),
    // A real RosterSnapshot, not a cast: `rosterStatus()` maps slotId →
    // mandatory position, so a stubbed shape would silently produce no needs
    // and every roster-driven assertion would pass for the wrong reason.
    // 0=QB, 2=RB, 4=WR, 6=TE, 17=K, 16=D/ST, 20=bench.
    roster: {
      slots: [
        { slotId: 0, label: "QB", count: 1 },
        { slotId: 2, label: "RB", count: 2 },
        { slotId: 4, label: "WR", count: 2 },
        { slotId: 6, label: "TE", count: 1 },
        { slotId: 17, label: "K", count: 1 },
        { slotId: 16, label: "D/ST", count: 1 },
        { slotId: 20, label: "BE", count: 4 },
      ],
      starting_slots: 8,
      bench_slots: 4,
    },
    teamCount: 6,
    preferred: new Set<number>(),
    adpFloor: null,
    freshness: { fetchedAt: "2026-08-04T12:00:00.000Z", stale: false },
    signalFreshness: new Map([
      ["offense", { computedAt: "2026-08-04T00:00:00.000Z", provenance: "derived:projections" }],
    ]),
    ...over,
  };
}
