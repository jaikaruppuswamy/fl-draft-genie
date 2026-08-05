// 007 — RoomState → exactly what the ratified layout needs.
//
// PURE, like the reducer. Guarded by `tests/room/purity.test.ts`.
//
// THIS FILE SPLITS ACROSS PHASES ON PURPOSE. `boardGrid()` and `rosterView()`
// are FOUNDATIONAL — US3's grid, US3's roster panel and US4's completed summary
// all depend on them. Only `railEntries()`, which applies the headline rule,
// belongs to US2.
//
// An earlier version of the plan put the whole module in US2 and then claimed
// US2/US3/US4 were mutually independent, which was simply false: US3 could not
// have started. `/speckit-analyze` caught it before anyone tried.

import type { Pick, RoomState } from "./draftRoom";

/** What the board knows about a player. Supplied by the caller from 006/002. */
export interface PlayerLookup {
  name: string;
  position: string;
  team: string;
}

export interface Cell {
  overall: number;
  label: string;
  teamId: number;
  /** Null for an unfilled cell, or a pick whose player we cannot name. */
  player: PlayerLookup | null;
  mine: boolean;
  current: boolean;
}

export interface BoardGrid {
  rounds: { label: string; cells: Cell[] }[];
  teamCount: number;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * The full grid of every team's pick, matching the ratified two-column layout.
 *
 * Bounded by construction — `rounds × teams` — so FR-021 costs nothing here.
 * The unbounded thing is raw frames, which the reducer discards after applying.
 */
export function boardGrid(
  state: RoomState,
  players: ReadonlyMap<number, PlayerLookup>,
  teamCount: number,
  rounds: number,
): BoardGrid {
  const byOverall = new Map<number, Pick>(state.picks.map((p) => [p.overall, p]));
  const frontier = state.picks.length + 1;
  const out: BoardGrid["rounds"] = [];

  for (let round = 1; round <= rounds; round++) {
    const cells: Cell[] = [];
    for (let slot = 1; slot <= teamCount; slot++) {
      const overall = (round - 1) * teamCount + slot;
      const pick = byOverall.get(overall);
      // Snake: even rounds run right to left. Derived from the round, never
      // from a field on the pick — 010 proved field 3 is not the round.
      const orderIndex = round % 2 === 1 ? slot - 1 : teamCount - slot;
      const teamId = pick?.teamId ?? state.order?.[orderIndex] ?? 0;
      cells.push({
        overall,
        label: `${round}.${pad(slot)}`,
        teamId,
        // A MISS IS NORMAL, not an error: a drafted player may be absent from
        // the board entirely — obscure, newly added, or a D/ST whose id is
        // negative around −16000. `playerId > 0` filtering is what made 010's
        // capture report 66 of 72 picks.
        player: pick ? (players.get(pick.playerId) ?? null) : null,
        mine: state.myTeamId !== null && teamId === state.myTeamId,
        current: overall === frontier,
      });
    }
    out.push({ label: `R${round}`, cells });
  }
  return { rounds: out, teamCount };
}

export interface RosterSlot {
  position: string;
  players: PlayerLookup[];
}

export interface RosterView {
  slots: RosterSlot[];
  /**
   * What the league still requires, taken from 006's WARNINGS rather than
   * recomputed here — so the screen and the engine cannot disagree about what
   * is unfilled. Recomputing it locally would be a second implementation of a
   * rule 006 already owns.
   */
  stillNeeded: string | null;
  forced: boolean;
}

export function rosterView(state: RoomState, players: ReadonlyMap<number, PlayerLookup>): RosterView {
  const mine = state.myTeamId === null ? [] : state.picks.filter((p) => p.teamId === state.myTeamId);
  const byPosition = new Map<string, PlayerLookup[]>();
  for (const p of mine) {
    const info = players.get(p.playerId);
    if (!info) continue; // unknown player: counted nowhere rather than guessed
    const list = byPosition.get(info.position);
    if (list) list.push(info);
    else byPosition.set(info.position, [info]);
  }

  const warning = state.recommendation?.warnings.find(
    (w) => w.kind === "mandatory_unfilled" || w.kind === "mandatory_unsatisfiable",
  );

  return {
    // Sorted so the panel does not reshuffle between renders.
    slots: [...byPosition.keys()].sort().map((position) => ({ position, players: byPosition.get(position)! })),
    stillNeeded: warning?.detail ?? null,
    forced: state.recommendation?.forced ?? false,
  };
}

// --- US2: the reasoning selector -------------------------------------------
//
// This is the only part of this file that belongs to User Story 2, because it
// is the only part that applies a RULE rather than a layout.

/** One recommended player, as the ratified 318px rail shows them. */
export interface RailEntry {
  playerId: number;
  name: string;
  position: string;
  team: string;
  rank: number;
  finalValue: number;
  /**
   * The one reason shown WITHOUT ANY INTERACTION. Never empty — an empty
   * headline is a bare name, which Constitution VII calls a spec violation.
   */
  headline: string;
  preferred: boolean;
  /** What the preference contributed, or null. 006 emits this for us to draw. */
  preferredValue: number | null;
  /** True when FR-025 forced the pick rather than the engine choosing it. */
  forced: boolean;
}

interface AdjustmentLike {
  rule: string;
  magnitude: number;
  direction: string;
  reason: string;
}

interface ShortlistLike {
  playerId: number;
  name: string;
  position: string;
  team: string;
  rank: number;
  finalValue: number;
  preferred: boolean;
  explanation?: {
    adjustments?: AdjustmentLike[];
    forcedBy?: string | null;
  };
}

/**
 * The headline reason for one player.
 *
 * The rule, in order:
 *
 *   1. `forcedBy` wins outright. "Forced: K still unfilled, 1 pick left" is more
 *      important than any adjustment, and it is the one case where the engine
 *      is not choosing at all.
 *   2. Otherwise the adjustment with the LARGEST ABSOLUTE MAGNITUDE, in 006's
 *      own phrasing. This is a `reduce` over the engine's output, not a
 *      judgement of our own — the biggest mover is the reason an owner would
 *      ask about first.
 *   3. Otherwise a plain statement that nothing applied (FR-008). Never blank.
 */
export function headlineFor(entry: ShortlistLike): string {
  const forced = entry.explanation?.forcedBy;
  if (forced) return forced;

  const adjustments = entry.explanation?.adjustments ?? [];
  if (adjustments.length === 0) return "no rule applied — ranked on value alone";

  // Ties break on rule name so two runs agree exactly (SC-003's determinism
  // cousin: the rail must not reshuffle between renders).
  const biggest = [...adjustments].sort(
    (a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude) || a.rule.localeCompare(b.rule),
  )[0]!;
  return biggest.reason;
}

export function railEntries(state: RoomState): RailEntry[] {
  const board = state.recommendation;
  if (!board || board.withheld) return [];
  return (board.shortlist as unknown as ShortlistLike[]).map((s) => {
    const preferredAdjustment = (s.explanation?.adjustments ?? []).find((a) => a.rule === "preferred");
    return {
      playerId: s.playerId,
      name: s.name,
      position: s.position,
      team: s.team,
      rank: s.rank,
      finalValue: s.finalValue,
      headline: headlineFor(s),
      preferred: s.preferred,
      // Taken from 006's field rather than recomputed — the screen must not
      // form its own opinion about what a preference was worth.
      preferredValue: preferredAdjustment ? preferredAdjustment.magnitude : null,
      forced: Boolean(s.explanation?.forcedBy),
    };
  });
}
