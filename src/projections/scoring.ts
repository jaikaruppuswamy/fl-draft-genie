// League-currency scoring (constitution III): projected stat lines × the
// league's lossless scoring map from 001. Rounding rule (contracts/api.md):
// internal math unrounded; totals round1(unrounded sum); breakdown lines
// round individually for display.

import type { BoardUniverseRow } from "../db/players";
import type { ProjectionRow } from "../db/projections";

export interface ScoringItemLike {
  statId: number;
  points: number;
  label?: string;
}

export interface BreakdownLine {
  statId: number;
  label: string;
  projected: number | null;
  points_per: number;
  points: number;
  covered: boolean;
}

export interface BoardEntry {
  espn_player_id: number;
  name: string;
  position: string;
  eligible_positions: string[];
  team: string;
  bye_week: number | null;
  projected_points: number | null;
  position_rank: number | null;
  adp: number | null;
  overall_rank: number | null;
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * FR-008/FR-009: one breakdown line per league scoring category. Uncovered
 * categories contribute zero (covered: false); projected stats the league
 * doesn't score are omitted. Returns the UNROUNDED total (null if no stat line).
 */
export function scoreStatLine(
  stats: Record<string, number> | null,
  items: ScoringItemLike[],
): { total: number | null; breakdown: BreakdownLine[] } {
  if (stats === null) return { total: null, breakdown: [] };
  let total = 0;
  const breakdown: BreakdownLine[] = [];
  for (const item of items) {
    const projected = stats[String(item.statId)];
    const covered = projected !== undefined;
    const unrounded = covered ? projected! * item.points : 0;
    total += unrounded;
    breakdown.push({
      statId: item.statId,
      label: item.label ?? `Stat #${item.statId}`,
      projected: covered ? projected! : null,
      points_per: item.points,
      points: round1(unrounded),
      covered,
    });
  }
  return { total, breakdown };
}

/** FR-011/FR-013: sorted board with per-position ranks and unprojected tail. */
export function buildLeagueBoard(
  players: BoardUniverseRow[],
  projections: Pick<ProjectionRow, "espn_player_id" | "stats_json" | "adp" | "overall_rank">[],
  items: ScoringItemLike[],
): BoardEntry[] {
  const projByPlayer = new Map(projections.map((p) => [p.espn_player_id, p]));

  const scored: { entry: BoardEntry; unrounded: number }[] = [];
  const unprojected: BoardEntry[] = [];

  for (const player of players) {
    const proj = projByPlayer.get(player.espn_player_id);
    const base: BoardEntry = {
      espn_player_id: player.espn_player_id,
      name: player.full_name,
      position: player.primary_position,
      eligible_positions: JSON.parse(player.eligible_positions) as string[],
      team: player.team_abbrev ?? "FA",
      bye_week: player.bye_week,
      projected_points: null,
      position_rank: null,
      adp: proj?.adp ?? null,
      overall_rank: proj?.overall_rank ?? null,
    };
    if (!proj) {
      unprojected.push(base);
      continue;
    }
    const { total } = scoreStatLine(JSON.parse(proj.stats_json) as Record<string, number>, items);
    if (total === null) {
      unprojected.push(base);
      continue;
    }
    scored.push({ entry: { ...base, projected_points: round1(total) }, unrounded: total });
  }

  scored.sort((a, b) => {
    if (b.unrounded !== a.unrounded) return b.unrounded - a.unrounded;
    const adpA = a.entry.adp ?? Infinity;
    const adpB = b.entry.adp ?? Infinity;
    if (adpA !== adpB) return adpA - adpB;
    return a.entry.name.localeCompare(b.entry.name);
  });

  const positionCounters = new Map<string, number>();
  for (const { entry } of scored) {
    const next = (positionCounters.get(entry.position) ?? 0) + 1;
    positionCounters.set(entry.position, next);
    entry.position_rank = next;
  }

  unprojected.sort((a, b) => a.name.localeCompare(b.name));
  return [...scored.map((s) => s.entry), ...unprojected];
}
