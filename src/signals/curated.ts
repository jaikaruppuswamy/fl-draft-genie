// Curated O-line signal (004 FR-003/SC-005): repo-versioned JSON, validated
// hard at load. An invalid file NEVER replaces stored values — the caller
// skips the write and the previous signal keeps serving (FR-008).

import type { SignalValue } from "../db/signals";

export interface CuratedOlineFile {
  kind: string;
  season: number;
  source: string;
  source_url?: string;
  seeded_at: string;
  provisional?: boolean;
  entries: { team_abbrev: string; rank: number }[];
}

export type CuratedValidation = { ok: true; file: CuratedOlineFile } | { ok: false; error: string };

export function validateCuratedOline(data: unknown): CuratedValidation {
  const f = data as CuratedOlineFile;
  if (!f || f.kind !== "oline" || !Array.isArray(f.entries)) {
    return { ok: false, error: "malformed curated oline file" };
  }
  if (f.entries.length !== 32) {
    return { ok: false, error: `curated oline must have exactly 32 entries, got ${f.entries.length}` };
  }
  const ranks = f.entries.map((e) => e.rank).sort((a, b) => a - b);
  const isPermutation = ranks.every((r, i) => r === i + 1);
  if (!isPermutation) {
    return { ok: false, error: "curated oline ranks must be a permutation of 1-32" };
  }
  if (!f.entries.every((e) => typeof e.team_abbrev === "string" && e.team_abbrev.length > 0)) {
    return { ok: false, error: "curated oline entries need team_abbrev strings" };
  }
  return { ok: true, file: f };
}

/**
 * Validate + resolve against known team abbrevs. Returns null when the file
 * is invalid (caller keeps previous values). Entries whose abbrev doesn't
 * resolve are skipped (in production all 32 resolve; test DBs carry fewer).
 * Rank → score orientation: rank 1 (best line) → 100.
 */
export function loadCuratedOline(
  data: unknown,
  abbrevToTeamId: Map<string, number>,
  now: Date,
): (SignalValue & { pro_team_id: number })[] | null {
  const check = validateCuratedOline(data);
  if (!check.ok) return null;
  const f = check.file;
  const provenance = `curated:${f.source}@${f.seeded_at}${f.provisional ? " (provisional)" : ""}`;
  const out: (SignalValue & { pro_team_id: number })[] = [];
  for (const entry of f.entries) {
    const teamId = abbrevToTeamId.get(entry.team_abbrev);
    if (teamId === undefined) continue;
    out.push({
      pro_team_id: teamId,
      raw_value: entry.rank,
      score: ((32 - entry.rank) / 31) * 100,
      rank: entry.rank,
      provenance,
      computed_at: now.toISOString(),
    });
  }
  return out;
}
