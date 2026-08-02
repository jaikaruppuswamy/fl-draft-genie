// Cadence policy for projection refreshes. Constants live in code — the
// cadence is deliberately not configurable (constitution IV spirit).
// isStale ships with the foundational phase (US1's board needs the stale
// flag); the top-up and rate-limit helpers arrive with US2 (T015).

/** Draft season (daily refresh): Aug 1 – Sep 30 UTC. Otherwise weekly. */
const DAY_MS = 24 * 60 * 60_000;
const DRAFT_SEASON_MAX_AGE_MS = DAY_MS;          // 24 h (SC-004)
const OFF_SEASON_MAX_AGE_MS = 7 * DAY_MS;        // 7 d

export function isDraftSeason(now: Date): boolean {
  const month = now.getUTCMonth() + 1;
  return month === 8 || month === 9;
}

export function isStale(fetchedAt: string | null, now: Date): boolean {
  if (!fetchedAt) return true;
  const age = now.getTime() - new Date(fetchedAt).getTime();
  return age > (isDraftSeason(now) ? DRAFT_SEASON_MAX_AGE_MS : OFF_SEASON_MAX_AGE_MS);
}
