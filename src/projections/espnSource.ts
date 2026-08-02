// Public ESPN fantasy v3 projection source (research.md §1). These endpoints
// are unauthenticated by design — NO Cookie header, ever: the global refresh
// runs with no user context (constitution: security constraints).

import type { Env } from "../env";
import { EspnError } from "../espn/types";

const DEFAULT_BASE = "https://lm-api-reads.fantasy.espn.com";

// defaultPositionId → position label.
const POSITIONS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
// Lineup-slot ids → position labels (for eligible_positions).
const SLOT_POSITIONS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DST", 17: "K", 23: "FLEX",
};

export interface SourcePlayer {
  espnPlayerId: number;
  fullName: string;
  primaryPosition: string;
  eligiblePositions: string[];
  proTeamId: number;
  active: boolean;
  injuryStatus: string | null;
  /** Raw projected stat line (statId → amount); null when unprojected (FR-004). */
  statLine: Record<string, number> | null;
  adp: number | null;
  overallRank: number | null;
}

export interface SourceProTeam {
  espnTeamId: number;
  abbrev: string;
  name: string;
  byeWeek: number | null;
}

interface KonaPlayerEntry {
  player?: {
    id?: number;
    fullName?: string;
    defaultPositionId?: number;
    eligibleSlots?: number[];
    proTeamId?: number;
    active?: boolean;
    injuryStatus?: string;
    ownership?: { averageDraftPosition?: number };
    draftRanksByRankType?: Record<string, { rank?: number }>;
    stats?: {
      seasonId?: number;
      statSourceId?: number;
      statSplitTypeId?: number;
      stats?: Record<string, number>;
    }[];
  };
}

async function publicGet(env: Env, url: string, headers: Record<string, string>): Promise<unknown> {
  const fetchImpl = env.ESPN_FETCH ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json", ...headers } });
  } catch {
    throw new EspnError("espn_unreachable");
  }
  if (!res.ok) throw new EspnError("espn_unreachable", res.status);
  try {
    return await res.json();
  } catch {
    throw new EspnError("espn_unreachable", res.status);
  }
}

export async function fetchPlayers(env: Env, season: number): Promise<SourcePlayer[]> {
  const base = env.ESPN_BASE_URL ?? DEFAULT_BASE;
  const url = `${base}/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const filter = {
    players: {
      limit: 1500,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "PPR" },
      filterStatsForSourceIds: { value: [1] },
    },
  };
  const json = (await publicGet(env, url, { "X-Fantasy-Filter": JSON.stringify(filter) })) as {
    players?: KonaPlayerEntry[];
  };

  const out: SourcePlayer[] = [];
  for (const entry of json.players ?? []) {
    const p = entry.player;
    if (!p || typeof p.id !== "number" || !p.fullName) continue;
    const seasonProjection = (p.stats ?? []).find(
      (s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && (s.seasonId === undefined || s.seasonId === season),
    );
    const statLine =
      seasonProjection?.stats && Object.keys(seasonProjection.stats).length > 0
        ? seasonProjection.stats
        : null;
    const eligible = [
      ...new Set((p.eligibleSlots ?? []).map((s) => SLOT_POSITIONS[s]).filter((x): x is string => !!x)),
    ];
    out.push({
      espnPlayerId: p.id,
      fullName: p.fullName,
      primaryPosition: POSITIONS[p.defaultPositionId ?? -1] ?? `POS${p.defaultPositionId}`,
      eligiblePositions: eligible,
      proTeamId: p.proTeamId ?? 0,
      active: p.active !== false,
      injuryStatus: p.injuryStatus ?? null,
      statLine,
      adp: p.ownership?.averageDraftPosition ?? null,
      overallRank: p.draftRanksByRankType?.["PPR"]?.rank ?? null,
    });
  }
  return out;
}

export async function fetchProTeams(env: Env, season: number): Promise<SourceProTeam[]> {
  const base = env.ESPN_BASE_URL ?? DEFAULT_BASE;
  const url = `${base}/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules_wl`;
  const json = (await publicGet(env, url, {})) as {
    settings?: { proTeams?: { id?: number; abbrev?: string; location?: string; name?: string; byeWeek?: number }[] };
  };
  return (json.settings?.proTeams ?? [])
    .filter((t) => typeof t.id === "number")
    .map((t) => ({
      espnTeamId: t.id!,
      abbrev: t.abbrev ?? "UNK",
      name: [t.location, t.name].filter(Boolean).join(" ") || (t.abbrev ?? "Unknown"),
      byeWeek: typeof t.byeWeek === "number" && t.byeWeek > 0 ? t.byeWeek : null,
    }));
}
