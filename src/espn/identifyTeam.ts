// FR-014: the user's team is the one whose owner list contains the member
// whose GUID equals the account's SWID (case-insensitive).

import type { EspnLeagueResponse } from "./types";

export function identifyMyTeam(res: EspnLeagueResponse, swid: string): number | null {
  const target = swid.toUpperCase();
  for (const team of res.teams ?? []) {
    if ((team.owners ?? []).some((guid) => guid.toUpperCase() === target)) {
      return team.id;
    }
  }
  return null;
}
