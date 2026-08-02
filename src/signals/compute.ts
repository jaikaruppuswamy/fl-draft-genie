// Context-signal computation (004): offense, SoS, curated O-line — one
// uniform shape, rank 1 / score 100 always the favorable end (research §3).

import type { Env } from "../env";
import { fetchProTeams, type SourcePlayer, type SourceProTeam } from "../projections/espnSource";
import { getServingSet, getSetRows } from "../db/projections";
import { replaceSignalKind, type SignalKind, type SignalValue } from "../db/signals";
import { DST_REFERENCE, OFFENSE_POSITIONS, OFFENSE_REFERENCE, referenceScore } from "./reference";
import { loadCuratedOline, validateCuratedOline } from "./curated";
import { currentSeason } from "../espn/leagueRef";
import { logError, logInfo } from "../api/logging";
import olineFile from "./data/oline-2026.json";

const PLAYOFF_WEEKS = new Set([15, 16, 17]);
const PLAYOFF_WEIGHT = 2;

/** Σ reference-scored stat lines of each team's projected QB/RB/WR/TE players. */
export function computeOffenseRaw(players: SourcePlayer[]): Map<number, number> {
  const raw = new Map<number, number>();
  for (const p of players) {
    if (!p.active || p.proTeamId === 0 || p.statLine === null) continue;
    if (!OFFENSE_POSITIONS.has(p.primaryPosition)) continue;
    raw.set(p.proTeamId, (raw.get(p.proTeamId) ?? 0) + referenceScore(p.statLine, OFFENSE_REFERENCE));
  }
  return raw;
}

/** Per-team D/ST reference score — the SoS ingredient (not itself served). */
export function computeDefensiveStrength(players: SourcePlayer[]): Map<number, number> {
  const strength = new Map<number, number>();
  for (const p of players) {
    if (!p.active || p.proTeamId === 0 || p.statLine === null) continue;
    if (p.primaryPosition !== "DST") continue;
    strength.set(p.proTeamId, (strength.get(p.proTeamId) ?? 0) + referenceScore(p.statLine, DST_REFERENCE));
  }
  return strength;
}

/**
 * Weighted mean of opponents' defensive strength (playoff weeks ×2, bye
 * omitted — a bye simply has no game). Opponents without a known strength
 * are filled with the mean of known strengths (neutral). Teams with no
 * schedule get no entry (→ dashes downstream).
 */
export function computeSosRaw(
  teams: SourceProTeam[],
  strength: Map<number, number>,
): Map<number, number> {
  const known = [...strength.values()];
  const meanStrength = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  const raw = new Map<number, number>();
  for (const team of teams) {
    if (team.espnTeamId === 0 || team.schedule.length === 0) continue;
    let weighted = 0;
    let weights = 0;
    for (const game of team.schedule) {
      const w = PLAYOFF_WEEKS.has(game.week) ? PLAYOFF_WEIGHT : 1;
      weighted += w * (strength.get(game.opponentProTeamId) ?? meanStrength);
      weights += w;
    }
    if (weights > 0) raw.set(team.espnTeamId, weighted / weights);
  }
  return raw;
}

export interface RankedEntry {
  pro_team_id: number;
  raw_value: number;
  score: number;
  rank: number;
}

/**
 * Min-max normalize to 0–100 with 100 at the favorable end, rank 1 favorable.
 * `favorable: "high"` means higher raw is better (offense); `"low"` means
 * lower raw is better (SoS). Ties break by team id — ranks are always a
 * distinct permutation.
 */
export function normalizeAndRank(raw: Map<number, number>, favorable: "high" | "low"): RankedEntry[] {
  const entries = [...raw.entries()].map(([pro_team_id, raw_value]) => ({ pro_team_id, raw_value }));
  if (entries.length === 0) return [];
  const values = entries.map((e) => e.raw_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const scored = entries.map((e) => {
    const t = span === 0 ? 1 : (e.raw_value - min) / span;
    const score = (favorable === "high" ? t : 1 - t) * 100;
    return { ...e, score };
  });
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.pro_team_id - b.pro_team_id));
  return scored.map((e, i) => ({ ...e, rank: i + 1 }));
}

const KIND_NOUNS: Record<SignalKind, string> = { offense: "offense", sos: "schedule", oline: "O-line" };

/** Fixed thresholds (assume 32-team population). */
export function signalLabel(kind: SignalKind, rank: number): string {
  const noun = KIND_NOUNS[kind];
  if (rank <= 5) return `Top-5 ${noun}`;
  if (rank <= 10) return `Top-10 ${noun}`;
  if (rank >= 28) return `Bottom-5 ${noun}`;
  if (rank >= 23) return `Bottom-10 ${noun}`;
  return `Mid-pack ${noun}`;
}

function toSignalValues(
  entries: RankedEntry[],
  provenance: string,
  computedAt: string,
): (SignalValue & { pro_team_id: number })[] {
  return entries.map((e) => ({
    pro_team_id: e.pro_team_id,
    raw_value: e.raw_value,
    score: e.score,
    rank: e.rank,
    provenance,
    computed_at: computedAt,
  }));
}

/**
 * Orchestrator (FR-007/FR-008): derives offense+sos from the serving
 * projection set (skipped, logged, when none exists — fresh deploy), loads
 * the curated oline file, writes each kind atomically. Never throws.
 * Test hook: opts.curatedOline overrides the bundled file.
 */
export async function computeSignals(
  env: Env,
  now: Date,
  opts: { curatedOline?: unknown } = {},
): Promise<void> {
  try {
    const season = currentSeason(now);
    const teams = await fetchProTeams(env, season);
    const abbrevs = new Map(teams.filter((t) => t.espnTeamId > 0).map((t) => [t.abbrev, t.espnTeamId]));

    // Curated oline (independent of projections).
    const curatedSource = opts.curatedOline ?? (olineFile as unknown);
    const curated = loadCuratedOline(curatedSource, abbrevs, now);
    if (curated) {
      await replaceSignalKind(env.DB, "oline", curated);
    } else {
      const check = validateCuratedOline(curatedSource);
      logError(`curated oline rejected: ${check.ok ? "abbrev resolution" : (check as { error: string }).error} — previous values keep serving`);
    }

    // Derived kinds need a serving projection set.
    const serving = await getServingSet(env.DB, season);
    if (!serving) {
      logInfo("signals: no serving projection set — derived kinds skipped");
      return;
    }
    const players = await fetchPlayersFromServingSet(env, season, serving.id);
    const provenance = `derived:projections@${serving.fetched_at}`;

    const offense = normalizeAndRank(computeOffenseRaw(players), "high");
    await replaceSignalKind(env.DB, "offense", toSignalValues(offense, provenance, serving.fetched_at));

    const sos = normalizeAndRank(computeSosRaw(teams, computeDefensiveStrength(players)), "low");
    await replaceSignalKind(env.DB, "sos", toSignalValues(sos, provenance, serving.fetched_at));

    logInfo(`signals computed: offense=${offense.length} sos=${sos.length} oline=${curated?.length ?? "kept"}`);
  } catch (err) {
    logError("signal computation failed — previous values keep serving", err);
  }
}

/**
 * Rebuild SourcePlayer-shaped records from the stored serving set (players
 * table + projection rows) so signals derive from exactly what the boards
 * serve, not a fresh fetch.
 */
async function fetchPlayersFromServingSet(env: Env, _season: number, setId: string): Promise<SourcePlayer[]> {
  const [rows, universe] = await Promise.all([
    getSetRows(env.DB, setId),
    env.DB.prepare("SELECT espn_player_id, primary_position, pro_team_id, active FROM players").all<{
      espn_player_id: number;
      primary_position: string;
      pro_team_id: number;
      active: number;
    }>(),
  ]);
  const statsByPlayer = new Map(rows.map((r) => [r.espn_player_id, JSON.parse(r.stats_json) as Record<string, number>]));
  return universe.results.map((p) => ({
    espnPlayerId: p.espn_player_id,
    fullName: "",
    primaryPosition: p.primary_position,
    eligiblePositions: [],
    proTeamId: p.pro_team_id,
    active: p.active === 1,
    injuryStatus: null,
    statLine: statsByPlayer.get(p.espn_player_id) ?? null,
    adp: null,
    overallRank: null,
  }));
}
