// 006 — shared fixture builders for the engine tests.
//
// Deliberately builds a bundle by hand rather than through `loadEngineBundle`:
// the engine's whole claim is that it is a function of its arguments, so its
// tests must be able to state those arguments directly, with no D1 anywhere
// near them.

import { detectAdpFloor } from "../../src/projections/adpFloor";
import { deriveState, type PlayerInfo } from "../../src/engine/state";
import type { EngineBundle, EngineState, SignalKind, SignalValue } from "../../src/engine/types";
import type { BoardEntry } from "../../src/projections/scoring";
import type { RosterSnapshot } from "../../src/espn/parsers";

/** QB1 RB2 WR2 TE1 FLEX1 K1 DST1 + 6 bench — a standard ESPN shape. */
export const ROSTER: RosterSnapshot = {
  slots: [
    { slotId: 0, label: "QB", count: 1 },
    { slotId: 2, label: "RB", count: 2 },
    { slotId: 4, label: "WR", count: 2 },
    { slotId: 6, label: "TE", count: 1 },
    { slotId: 23, label: "FLEX", count: 1 },
    { slotId: 16, label: "D/ST", count: 1 },
    { slotId: 17, label: "K", count: 1 },
    { slotId: 20, label: "Bench", count: 6 },
  ],
  starting_slots: 9,
  bench_slots: 6,
};

export const TEAM_COUNT = 12;

export interface MakePlayer {
  id: number;
  position: string;
  points: number | null;
  adp?: number | null;
  bye?: number | null;
  proTeam?: number;
  name?: string;
}

export function boardEntry(p: MakePlayer): BoardEntry {
  return {
    espn_player_id: p.id,
    name: p.name ?? `Player ${p.id}`,
    position: p.position,
    eligible_positions: [p.position],
    team: `T${p.proTeam ?? 1}`,
    bye_week: p.bye ?? null,
    projected_points: p.points,
    position_rank: null,
    adp: p.adp === undefined ? null : p.adp,
    overall_rank: null,
  };
}

/**
 * A realistically shaped board: deep at every position, with ADPs that
 * SATURATE the way ESPN's do — so every test that touches ADP meets the floor
 * rather than an idealised spread.
 */
export function makeBoard(options: { receptionBoost?: number; count?: number } = {}): BoardEntry[] {
  const boost = options.receptionBoost ?? 0;
  const per = options.count ?? 40;
  const out: BoardEntry[] = [];
  let id = 1000;
  const shape: [string, number, number][] = [
    ["RB", 200, 3],
    ["WR", 190, 3],
    ["TE", 150, 4],
    ["QB", 280, 4],
    ["K", 120, 1],
    ["DST", 110, 1],
  ];
  let adpRank = 1;
  for (const [position, top, step] of shape) {
    for (let i = 0; i < per; i++) {
      const receiving = position === "WR" || position === "TE" ? boost : 0;
      // ESPN's floor: real values for roughly the first 170, then a wall.
      const adp = adpRank <= 170 ? adpRank + 0.3 : 169.9 + (adpRank % 20) * 0.01;
      out.push(
        boardEntry({
          id: id++,
          position,
          points: top - i * step + receiving,
          adp,
          bye: 5 + (i % 9),
          proTeam: 1 + (i % 32),
        }),
      );
      adpRank++;
    }
  }
  return out;
}

export function signalMap(kinds: SignalKind[] = ["offense", "sos", "oline"]): Map<
  SignalKind,
  Map<number, SignalValue>
> {
  const m = new Map<SignalKind, Map<number, SignalValue>>();
  for (const kind of kinds) {
    const inner = new Map<number, SignalValue>();
    for (let team = 1; team <= 32; team++) {
      // Spread deterministically across the 0–100 range.
      const score = ((team * 7) % 32) * (100 / 31);
      inner.set(team, {
        raw_value: score,
        score,
        rank: team,
        provenance: "test",
        computed_at: "2026-08-01T00:00:00.000Z",
      });
    }
    m.set(kind, inner);
  }
  return m;
}

export function makeBundle(over: Partial<EngineBundle> = {}): EngineBundle {
  const players = over.players ?? makeBoard();
  return {
    players,
    signals: signalMap(),
    proTeamByPlayer: new Map(
      players.map((p) => [p.espn_player_id, Number(p.team.replace("T", "")) || 1]),
    ),
    roster: ROSTER,
    teamCount: TEAM_COUNT,
    preferred: new Set(),
    adpFloor: detectAdpFloor(players.map((p) => p.adp)),
    freshness: { fetchedAt: "2026-08-05T12:00:00.000Z", stale: false },
    signalFreshness: new Map(),
    ...over,
  };
}

export function playerInfoFrom(players: readonly BoardEntry[]): Map<number, PlayerInfo> {
  return new Map(players.map((p) => [p.espn_player_id, { position: p.position, byeWeek: p.bye_week }]));
}

export const ORDER = Array.from({ length: TEAM_COUNT }, (_, i) => i + 1);

/** State at a given point in a synthetic draft, with picks taken off the top. */
export function makeState(
  bundle: EngineBundle,
  options: {
    picksMade?: number;
    myTeamId?: number;
    keepers?: Map<number, number>;
    withholding?: EngineState["withholding"];
    totalPicks?: number;
  } = {},
): EngineState {
  const n = options.picksMade ?? 0;
  const ordered = [...bundle.players]
    .filter((p) => p.projected_points !== null)
    .sort((a, b) => b.projected_points! - a.projected_points! || a.espn_player_id - b.espn_player_id);
  const picks = ordered.slice(0, n).map((p, k) => ({
    overall: k + 1,
    teamId: ORDER[k % TEAM_COUNT]!,
    playerId: p.espn_player_id,
  }));
  return deriveState({
    revision: 1,
    picks,
    order: ORDER,
    myTeamId: options.myTeamId ?? 1,
    totalPicks: options.totalPicks ?? TEAM_COUNT * 15,
    keepers: options.keepers ?? new Map(),
    playerInfo: playerInfoFrom(bundle.players),
    withholding: options.withholding ?? null,
  });
}
