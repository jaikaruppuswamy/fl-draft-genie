// FR-010: connect by ESPN league ID or pasted league URL.

export interface LeagueRef {
  leagueId: string;
  season?: number;
}

/** NFL fantasy season for a given date: Apr–Dec → that year, Jan–Mar → previous. */
export function currentSeason(now: Date): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() + 1 >= 4 ? y : y - 1;
}

export function parseLeagueRef(raw: string): LeagueRef | null {
  const v = raw.trim();
  if (/^\d{1,12}$/.test(v)) return { leagueId: v };
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (!/(^|\.)espn\.com$/.test(url.hostname)) return null;
  const leagueId = url.searchParams.get("leagueId");
  if (leagueId && /^\d{1,12}$/.test(leagueId)) {
    const seasonRaw = url.searchParams.get("seasonId");
    const season = seasonRaw && /^\d{4}$/.test(seasonRaw) ? Number(seasonRaw) : undefined;
    return { leagueId, season };
  }
  // Newer path style: /football/league/... has leagueId in query only; nothing else to try.
  return null;
}
