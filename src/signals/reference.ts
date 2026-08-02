// Fixed reference scoring maps for cross-team signal computation ONLY
// (research §2). These are NOT league scoring: league-currency points on
// boards always come from each league's own synced scoring map
// (constitution III). Signals are global and need one consistent yardstick;
// ranks are ordinal, so the exact values barely matter.

/** Offense reference: standard yardage/TD values with 0.5 PPR. */
export const OFFENSE_REFERENCE: Record<string, number> = {
  "3": 0.04, // passing yards
  "4": 4, // passing TD
  "20": -2, // interceptions thrown
  "24": 0.1, // rushing yards
  "25": 6, // rushing TD
  "42": 0.1, // receiving yards
  "43": 6, // receiving TD
  "53": 0.5, // receptions
  "72": -2, // fumbles lost
};

/** D/ST reference (defensive strength — the SoS ingredient). */
export const DST_REFERENCE: Record<string, number> = {
  "99": 1, // sacks
  "95": 2, // interceptions
  "96": 2, // fumble recoveries
  "97": 2, // blocked kicks
  "98": 2, // safeties
  "101": 6, // kickoff return TD
  "102": 6, // punt return TD
  "103": 6, // fumble return TD
  "104": 6, // interception return TD
};

export function referenceScore(stats: Record<string, number>, map: Record<string, number>): number {
  let total = 0;
  for (const [statId, value] of Object.entries(stats)) {
    const points = map[statId];
    if (points !== undefined) total += value * points;
  }
  return total;
}

/** Offensive positions contributing to team offensive potential. */
export const OFFENSE_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
