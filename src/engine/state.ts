// 006 T010 — turn 005's session snapshot into the engine's fast-changing half.
//
// PURE. No platform imports, no clock.
//
// THE ONE THING THIS FILE HAS TO GET RIGHT is `drafted`. A player who is gone
// but that the engine believes is available gets recommended, and recommending
// a player who was taken two picks ago is the single most visible way this
// feature can be wrong. Three sources feed it, and TWO of them are easy to miss:
//
//  1. Confirmed picks — a ledger snapshot said so. Obvious.
//
//  2. Pending picks — the live stream saw the selection but no ledger has
//     confirmed its OVERALL NUMBER yet. The uncertainty is about the ordinal,
//     never about whether the player is gone. 005's `materialise()` already
//     unions these into `SessionSnapshot.picks`, which is why this file reads
//     `picks` rather than reaching for the two lists separately.
//
//  3. Keepers — rostered before pick 1, on EVERY team, not just the owner's
//     (FR-002). In some leagues they never arrive as picks at all. Every league
//     this project has tested against is a redraft, so this omission would have
//     been invisible until it reached someone else's league.
//
// Number 2 is the same shape as the bug that made 005's reducer silently delete
// picks, and number 3 was caught by `/speckit-analyze` rather than by anyone
// reading the code.

import { picksUntilTurn, remainingSchedule } from "../draft/snake";
import type { EngineState, RosteredPlayer } from "./types";

/** Position and bye for one player, looked up from the board by the caller. */
export interface PlayerInfo {
  position: string;
  byeWeek: number | null;
}

export interface DeriveInput {
  revision: number;
  /** 005's materialised picks — already `confirmed` ∪ `pending`. */
  picks: readonly { overall: number; teamId: number; playerId: number }[];
  /** The published or observed pick order. Empty means unknown. */
  order: readonly number[];
  myTeamId: number | null;
  /** Teams × roster spots, or 0 when not yet known — never treated as a total. */
  totalPicks: number;
  /** Kept players across ALL teams, mapped to the team holding them. */
  keepers: ReadonlyMap<number, number>;
  /** playerId → position and bye, from the board. Misses are tolerated. */
  playerInfo: ReadonlyMap<number, PlayerInfo>;
  withholding: { reason: string; detail: string } | null;
}

/** How many recent picks the positional-run window looks back over. */
export function runWindow(teamCount: number): number {
  return Math.max(1, teamCount);
}

export function deriveState(i: DeriveInput): EngineState {
  const keeperIds = new Set(i.keepers.keys());

  const drafted = new Set<number>();
  for (const p of i.picks) drafted.add(p.playerId);
  for (const id of keeperIds) drafted.add(id);

  const myRoster: RosteredPlayer[] = [];
  const push = (playerId: number): void => {
    // A miss is NORMAL, not an error: a drafted player may be absent from the
    // board entirely (obscure, newly added, or a D/ST whose id is negative).
    // It contributes nothing to needs or bye clashes and must not throw —
    // `playerId > 0` filtering is what made 010's capture report 66 of 72.
    const info = i.playerInfo.get(playerId);
    if (info) myRoster.push({ playerId, position: info.position, byeWeek: info.byeWeek });
  };
  if (i.myTeamId !== null) {
    for (const p of i.picks) if (p.teamId === i.myTeamId) push(p.playerId);
    for (const [playerId, teamId] of i.keepers) if (teamId === i.myTeamId) push(playerId);
  }

  const frontier = i.picks.length + 1;
  const observed = new Map(i.picks.map((p) => [p.overall, p.teamId]));

  // NULL means there is no next turn — the owner's final pick. 005's helper
  // already returns null for that case, and FR-023 requires it be treated as
  // "the rule does not apply", never as a gap of zero or a gap of infinity.
  const gapToNextTurn =
    i.myTeamId === null
      ? null
      : picksUntilTurn({
          order: i.order,
          frontier,
          myTeamId: i.myTeamId,
          observed,
          totalPicks: i.totalPicks > 0 ? i.totalPicks : undefined,
        });

  const myRemainingPicks =
    i.myTeamId === null || i.totalPicks <= 0
      ? 0
      : remainingSchedule({
          order: i.order,
          frontier,
          myTeamId: i.myTeamId,
          totalPicks: i.totalPicks,
        }).length;

  // Newest last. Keepers are deliberately EXCLUDED: a run is about what the
  // room is doing right now, and pre-draft keeps say nothing about that.
  const recentPositions = i.picks
    .slice()
    .sort((a, b) => a.overall - b.overall)
    .map((p) => i.playerInfo.get(p.playerId)?.position)
    .filter((pos): pos is string => pos !== undefined);

  return {
    revision: i.revision,
    currentOverall: frontier,
    drafted,
    keepers: keeperIds,
    myRoster,
    gapToNextTurn,
    myRemainingPicks,
    recentPositions,
    withholding: i.withholding,
  };
}
