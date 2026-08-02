// Boris Chen positional tiers (spec 003 FR-002/FR-003): public text feeds,
// format `Tier N: Name, Name, …`. Live-verified 2026-08-02 (plan.md).
// GET-only, no credentials — same posture as the projection source.

import type { Env } from "../env";
import { replaceTierFeed } from "../db/tiers";
import { logError, logInfo } from "../api/logging";

const DEFAULT_BASE = "https://s3-us-west-1.amazonaws.com/fftiers/out";

export type TierFormat = "ppr" | "half" | "std";
/** QB/K/DST feeds are format-independent; stored under pseudo-format 'all'. */
export const FORMAT_ALL = "all";

const SHARED_POSITIONS = ["QB", "K", "DST"] as const;
const FORMAT_POSITIONS = ["RB", "WR", "TE"] as const;

function feedKey(position: string, format: TierFormat): string {
  if (format === "ppr") return `${position}-PPR`;
  if (format === "half") return `${position}-HALF`;
  return position;
}

/** League reception value → tier format (spec 003 FR-004 mapping). */
export function tierFormatForLeague(receptionPoints: number | null): TierFormat {
  if (receptionPoints !== null && receptionPoints >= 0.75) return "ppr";
  if (receptionPoints !== null && receptionPoints >= 0.25) return "half";
  return "std";
}

/**
 * Normalize a player name for matching: lowercase, strip diacritics and
 * punctuation, drop suffixes (Jr/Sr/II–V). For DST, both sides reduce to the
 * team nickname ("Denver Broncos" and "Broncos D/ST" → "broncos").
 */
export function normalizeName(name: string, position: string): string {
  let tokens = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  tokens = tokens.filter((t) => !["jr", "sr", "ii", "iii", "iv", "v"].includes(t));
  if (position === "DST") {
    tokens = tokens.filter((t) => t !== "d/st" && t !== "dst");
    return tokens[tokens.length - 1] ?? "";
  }
  return tokens.join(" ");
}

export function parseTierText(text: string, position: string): { name_norm: string; tier: number }[] {
  const entries: { name_norm: string; tier: number }[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^Tier\s+(\d+):\s*(.+)$/i);
    if (!match) continue;
    const tier = Number(match[1]);
    for (const raw of match[2]!.split(",")) {
      const name_norm = normalizeName(raw.trim(), position);
      if (name_norm) entries.push({ name_norm, tier });
    }
  }
  return entries;
}

async function fetchFeed(env: Env, key: string): Promise<string | null> {
  const base = env.TIERS_BASE_URL ?? DEFAULT_BASE;
  const fetchImpl = env.ESPN_FETCH ?? fetch; // shared test-injectable fetch
  try {
    const res = await fetchImpl(`${base}/text_${key}.txt`, { headers: { Accept: "text/plain" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Refresh all tier feeds. Per-feed all-or-nothing: a failed feed keeps its
 * previous entries (FR-002). Never throws — tier failures must not break
 * projection refreshes.
 */
export async function ingestTiers(env: Env, now: Date): Promise<void> {
  let feeds = 0;
  let entries = 0;
  // Format-independent positions once…
  for (const position of SHARED_POSITIONS) {
    const text = await fetchFeed(env, feedKey(position, "std"));
    if (text === null) continue;
    const parsed = parseTierText(text, position);
    if (parsed.length === 0) continue; // format drift → fail safe (spec edge case)
    await replaceTierFeed(env.DB, FORMAT_ALL, position, parsed, now);
    feeds++;
    entries += parsed.length;
  }
  // …format-specific positions per format, with base-feed fallback.
  for (const format of ["ppr", "half", "std"] as TierFormat[]) {
    for (const position of FORMAT_POSITIONS) {
      const text =
        (await fetchFeed(env, feedKey(position, format))) ??
        (await fetchFeed(env, feedKey(position, "std")));
      if (text === null) continue;
      const parsed = parseTierText(text, position);
      if (parsed.length === 0) continue;
      await replaceTierFeed(env.DB, format, position, parsed, now);
      feeds++;
      entries += parsed.length;
    }
  }
  if (feeds === 0) {
    logError("tier ingest: no feeds fetched — previous tiers keep serving");
  } else {
    logInfo(`tier ingest: ${feeds} feeds, ${entries} entries`);
  }
}
