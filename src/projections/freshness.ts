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

/** On-demand refresh floor (FR-016): one global refresh per 15 minutes. */
const ON_DEMAND_MIN_INTERVAL_MS = 15 * 60_000;

export function rateLimited(newestSetFetchedAt: string | null, now: Date): boolean {
  if (!newestSetFetchedAt) return false;
  return now.getTime() - new Date(newestSetFetchedAt).getTime() < ON_DEMAND_MIN_INTERVAL_MS;
}

/** Pre-draft window length must match the 001 cron scan (sync/predraft). */
const PRE_DRAFT_WINDOW_MS = 75 * 60_000;

/**
 * Draft-day top-up (SC-007): due when a league's draft window is open and the
 * serving set predates the window opening. Self-clearing: after the refresh,
 * the serving set postdates the opening.
 */
export function dueForDraftDayTopUp(
  draftTimes: (string | null)[],
  servingFetchedAt: string | null,
  now: Date,
): boolean {
  if (!servingFetchedAt) return true;
  const serving = new Date(servingFetchedAt).getTime();
  for (const draftAt of draftTimes) {
    if (!draftAt) continue;
    const draft = new Date(draftAt).getTime();
    const windowOpen = draft - PRE_DRAFT_WINDOW_MS;
    if (now.getTime() >= windowOpen && now.getTime() <= draft && serving < windowOpen) {
      return true;
    }
  }
  return false;
}
