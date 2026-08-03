// Read-only ESPN fantasy v3 client (constitution VI: no write methods exist).
// Credentials travel only in the Cookie header — never in URLs (FR-006).
// Politeness: the sync layer enforces a 30 s minimum between full syncs of the
// same league (research.md §7); this client stays a dumb fetcher.

import type { Env } from "../env";
import { EspnError, type EspnLeagueResponse } from "./types";

const DEFAULT_BASE = "https://lm-api-reads.fantasy.espn.com";

export interface EspnCredentials {
  espnS2: string;
  swid: string;
}

export type EspnView = "mSettings" | "mTeam" | "mDraftDetail" | "mRoster";

export function createEspnClient(env: Env, creds: EspnCredentials) {
  const base = env.ESPN_BASE_URL ?? DEFAULT_BASE;
  const fetchImpl = env.ESPN_FETCH ?? fetch;

  async function fetchLeague(
    season: number,
    leagueId: string,
    views: EspnView[],
  ): Promise<EspnLeagueResponse> {
    const query = views.map((v) => `view=${v}`).join("&");
    const url = `${base}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}?${query}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: `espn_s2=${creds.espnS2}; SWID=${creds.swid}`,
        },
      });
    } catch {
      throw new EspnError("espn_unreachable");
    }
    if (res.status === 401 || res.status === 403) throw new EspnError("espn_rejected", res.status);
    if (res.status === 404) throw new EspnError("league_not_found", 404);
    if (!res.ok) throw new EspnError("espn_unreachable", res.status);
    try {
      return (await res.json()) as EspnLeagueResponse;
    } catch {
      throw new EspnError("espn_unreachable", res.status);
    }
  }

  return {
    fetchLeague,
    /** Cheap credential probe: any authenticated ffl request that returns non-401. */
    async probeCredentials(season: number): Promise<void> {
      const url = `${base}/apis/v3/games/ffl/seasons/${season}?view=kona_league_messaging`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", Cookie: `espn_s2=${creds.espnS2}; SWID=${creds.swid}` },
        });
      } catch {
        throw new EspnError("espn_unreachable");
      }
      if (res.status === 401 || res.status === 403) throw new EspnError("espn_rejected", res.status);
      if (res.status >= 500) throw new EspnError("espn_unreachable", res.status);
    },
  };
}
