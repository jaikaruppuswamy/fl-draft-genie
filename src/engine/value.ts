// 006 T017 — value over positional replacement, and the unit everything else
// is measured in.
//
// PURE. No platform imports, no clock.
//
// WHY REPLACEMENT LEVEL AT ALL (FR-004): a 300-point quarterback and a
// 200-point running back are not comparable until you know what you would get
// at each position ANYWAY. If every team starts one QB and the 12th-best QB
// scores 280, the "300-point" quarterback is worth 20. That is the whole idea,
// and without it the engine ranks positions in isolation and recommends
// quarterbacks all afternoon.
//
// WHY FLEX IS ALLOCATED BY VALUE: the boundary depends on how many of each
// position the league actually starts, and flex slots make that a function of
// SCORING, not just of roster settings. A full-PPR league genuinely starts more
// receivers than a standard one with identical slots. A fixed split — "flex is
// 60% RB" — is a guess about a typical league dressed up as a derivation, and
// Constitution II and III both exist to stop that. Filling flex greedily by the
// league's own points makes the baseline move on its own.

import type { BoardEntry } from "../projections/scoring";
import type { RosterSnapshot } from "../espn/parsers";

/** ESPN lineup slots that start exactly one position. */
const DEDICATED: Record<number, string> = {
  0: "QB",
  2: "RB",
  4: "WR",
  6: "TE",
  16: "DST",
  17: "K",
};

/** ESPN lineup slots that accept several positions. */
const FLEXIBLE: Record<number, readonly string[]> = {
  3: ["RB", "WR"],
  5: ["WR", "TE"],
  7: ["QB", "RB", "WR", "TE"], // OP — superflex
  23: ["RB", "WR", "TE"], // FLEX
};

const BENCH_SLOT = 20;
const IR_SLOT = 21;

/** ESPN writes D/ST both ways depending on the surface; normalise once. */
export function normalisePosition(position: string): string {
  return position === "D/ST" ? "DST" : position;
}

export interface Baselines {
  /** position → the points of the last league-wide starter at it. */
  replacement: Map<string, number>;
  /** position → how many of it the league starts in total. */
  boundary: Map<string, number>;
  /** Which positions the league mandates at all, and how many per team. */
  startersPerTeam: Map<string, number>;
}

/**
 * Where does each position stop being a starter, league-wide?
 *
 * Steps 1–2 assign the dedicated slots; step 3 fills the flex slots greedily by
 * value. Slots are processed MOST RESTRICTIVE FIRST so a narrow slot (RB/WR)
 * is not starved by a general one (FLEX) having already taken its candidates —
 * and ties break on slot id so the result is deterministic (FR-017).
 */
export function computeBaselines(
  players: readonly BoardEntry[],
  roster: RosterSnapshot,
  teamCount: number,
): Baselines {
  // Projected players only. About half the 1026-player universe carries no
  // projection; counting them toward a boundary would drag every baseline to
  // nothing.
  const byPosition = new Map<string, BoardEntry[]>();
  for (const p of players) {
    if (p.projected_points === null) continue;
    const pos = normalisePosition(p.position);
    const list = byPosition.get(pos);
    if (list) list.push(p);
    else byPosition.set(pos, [p]);
  }
  for (const list of byPosition.values()) {
    // Descending points; the id breaks ties so repeated calls agree exactly.
    list.sort((a, b) => b.projected_points! - a.projected_points! || a.espn_player_id - b.espn_player_id);
  }

  const boundary = new Map<string, number>();
  const startersPerTeam = new Map<string, number>();
  /** How many of each position the flex fill has already consumed. */
  const taken = new Map<string, number>();

  for (const slot of roster.slots) {
    if (slot.slotId === BENCH_SLOT || slot.slotId === IR_SLOT) continue;
    const pos = DEDICATED[slot.slotId];
    if (!pos) continue;
    boundary.set(pos, (boundary.get(pos) ?? 0) + teamCount * slot.count);
    taken.set(pos, (taken.get(pos) ?? 0) + teamCount * slot.count);
    startersPerTeam.set(pos, (startersPerTeam.get(pos) ?? 0) + slot.count);
  }

  const flexSlots = roster.slots
    .filter((s) => FLEXIBLE[s.slotId] !== undefined && s.count > 0)
    .sort((a, b) => FLEXIBLE[a.slotId]!.length - FLEXIBLE[b.slotId]!.length || a.slotId - b.slotId);

  for (const slot of flexSlots) {
    const eligible = FLEXIBLE[slot.slotId]!;
    for (const pos of eligible) startersPerTeam.set(pos, startersPerTeam.get(pos) ?? 0);
    const openings = teamCount * slot.count;
    for (let n = 0; n < openings; n++) {
      // The single best player, in THIS league's scoring, still unclaimed at
      // any position this slot accepts. Nothing here knows what PPR is; it just
      // reads the points the league produced.
      let bestPos: string | null = null;
      let bestPoints = -Infinity;
      for (const pos of eligible) {
        const list = byPosition.get(pos);
        if (!list) continue;
        const idx = taken.get(pos) ?? 0;
        const candidate = list[idx];
        if (!candidate) continue;
        if (
          candidate.projected_points! > bestPoints ||
          (candidate.projected_points! === bestPoints && bestPos !== null && pos < bestPos)
        ) {
          bestPoints = candidate.projected_points!;
          bestPos = pos;
        }
      }
      if (bestPos === null) break; // nobody eligible left; the slot goes unfilled
      taken.set(bestPos, (taken.get(bestPos) ?? 0) + 1);
      boundary.set(bestPos, (boundary.get(bestPos) ?? 0) + 1);
    }
  }

  const replacement = new Map<string, number>();
  for (const [pos, list] of byPosition) {
    if (list.length === 0) continue;
    const count = boundary.get(pos) ?? 0;
    if (count <= 0) {
      // The league starts none of this position. Baseline at its own best, so
      // every player at it values at <= 0 and can never displace a usable one.
      replacement.set(pos, list[0]!.projected_points!);
      continue;
    }
    // The LAST starter, clamped: a pool shorter than its boundary baselines at
    // its worst player rather than indexing off the end.
    const idx = Math.min(count, list.length) - 1;
    replacement.set(pos, list[idx]!.projected_points!);
  }

  return { replacement, boundary, startersPerTeam };
}

/**
 * Points above replacement, in the league's own currency.
 *
 * `null` for a player with no projection — they carry no value, which is
 * different from carrying zero, and they sort behind every valued player.
 */
export function valueOf(player: BoardEntry, baselines: Baselines): number | null {
  if (player.projected_points === null) return null;
  const pos = normalisePosition(player.position);
  const replacement = baselines.replacement.get(pos);
  if (replacement === undefined) return player.projected_points;
  return player.projected_points - replacement;
}

/**
 * `ROUND_VALUE` — what an owner gives up by waiting one full round.
 *
 * THE UNIT every adjustment in the engine is a fraction of. It scales with the
 * league's scoring, with team count, and with depth into the draft — values
 * flatten late, so it shrinks, and so does every adjustment. That last part is
 * correct rather than a bug: reaching matters less in round 15 than round 2.
 *
 * `values` must be the available pool's values, descending.
 */
export function roundValue(values: readonly number[], teamCount: number): number {
  if (values.length < 2) return 0;
  const top = values[0]!;
  // A full round ahead if the board is deep enough; otherwise the whole
  // remaining spread, which is the most a round could possibly cost.
  const other = values[Math.min(teamCount, values.length - 1)]!;
  return Math.max(0, top - other);
}
