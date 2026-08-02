// ESPN response → snapshot shapes. The scoring map is stored losslessly
// (constitution III): every scoringItem survives, labeled where we know the
// stat id and passed through as "Stat #N" where we don't.

import type { EspnLeagueResponse } from "./types";

// Partial ESPN stat-id → label map (display only; unknown ids still stored).
const STAT_LABELS: Record<number, string> = {
  0: "Pass Attempts",
  1: "Completions",
  3: "Passing Yards",
  4: "Passing TD",
  19: "2-Pt Pass",
  20: "Interceptions Thrown",
  23: "Rush Attempts",
  24: "Rushing Yards",
  25: "Rushing TD",
  26: "2-Pt Rush",
  42: "Receiving Yards",
  43: "Receiving TD",
  44: "2-Pt Reception",
  53: "Receptions",
  72: "Fumbles Lost",
  74: "FG Made 50+",
  77: "FG Made 40-49",
  80: "FG Made 0-39",
  85: "FG Missed",
  86: "Extra Point Made",
  89: "0 Points Allowed",
  90: "1-6 Points Allowed",
  95: "Defensive Interception",
  96: "Fumble Recovery",
  97: "Blocked Kick",
  98: "Safety",
  99: "Sack",
  101: "Kickoff Return TD",
  102: "Punt Return TD",
  103: "Fumble Return TD",
  104: "Interception Return TD",
};

const SLOT_LABELS: Record<number, string> = {
  0: "QB",
  1: "TQB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  16: "D/ST",
  17: "K",
  20: "Bench",
  21: "IR",
  23: "FLEX",
};

const RECEPTION_STAT_ID = 53;
const RECEIVING_STAT_IDS = [42, 43, 44, 53];
const BENCH_SLOT_ID = 20;
const IR_SLOT_ID = 21;

export interface ScoringSnapshot {
  scoring_type: string | null;
  items: { statId: number; label: string; points: number }[];
  reception_points: number | null;
}

export interface RosterSnapshot {
  slots: { slotId: number; label: string; count: number }[];
  starting_slots: number;
  bench_slots: number;
}

export interface DraftSnapshot {
  type: string | null;
  supported: boolean;
  scheduled_at: string | null;
  order: number[] | null;
  started: boolean;
  completed: boolean;
}

export interface TeamSnapshot {
  espn_team_id: number;
  name: string;
  manager_names: string[];
}

export interface ParsedLeague {
  league_name: string;
  season: number;
  team_count: number;
  scoring: ScoringSnapshot;
  roster: RosterSnapshot;
  draft: DraftSnapshot;
  teams: TeamSnapshot[];
}

export function teamDisplayName(t: { name?: string; location?: string; nickname?: string; id: number }): string {
  if (t.name?.trim()) return t.name.trim();
  const joined = [t.location, t.nickname].filter((s) => s?.trim()).join(" ");
  return joined || `Team ${t.id}`;
}

export function parseLeague(res: EspnLeagueResponse): ParsedLeague {
  const settings = res.settings ?? {};

  const items = (settings.scoringSettings?.scoringItems ?? []).map((it) => ({
    statId: it.statId,
    label: STAT_LABELS[it.statId] ?? `Stat #${it.statId}`,
    points: it.points,
  }));
  const receptionItem = items.find((it) => it.statId === RECEPTION_STAT_ID);
  const scoring: ScoringSnapshot = {
    scoring_type: settings.scoringSettings?.scoringType ?? null,
    items,
    reception_points: receptionItem ? receptionItem.points : null,
  };

  const slotCounts = settings.rosterSettings?.lineupSlotCounts ?? {};
  const slots = Object.entries(slotCounts)
    .map(([slotId, count]) => ({
      slotId: Number(slotId),
      label: SLOT_LABELS[Number(slotId)] ?? `Slot #${slotId}`,
      count: Number(count),
    }))
    .filter((s) => s.count > 0)
    .sort((a, b) => a.slotId - b.slotId);
  const roster: RosterSnapshot = {
    slots,
    starting_slots: slots
      .filter((s) => s.slotId !== BENCH_SLOT_ID && s.slotId !== IR_SLOT_ID)
      .reduce((sum, s) => sum + s.count, 0),
    bench_slots: slots.find((s) => s.slotId === BENCH_SLOT_ID)?.count ?? 0,
  };

  const ds = settings.draftSettings ?? {};
  const order = ds.pickOrder && ds.pickOrder.length > 0 ? ds.pickOrder : null;
  const draft: DraftSnapshot = {
    type: ds.type ?? null,
    // Live-draft assistance initially covers online snake drafts (spec edge case).
    supported: ds.type === "SNAKE",
    scheduled_at: typeof ds.date === "number" ? new Date(ds.date).toISOString() : null,
    order,
    started: res.draftDetail?.inProgress ?? false,
    completed: res.draftDetail?.drafted ?? false,
  };

  const membersById = new Map((res.members ?? []).map((m) => [m.id.toUpperCase(), m]));
  const teams: TeamSnapshot[] = (res.teams ?? []).map((t) => ({
    espn_team_id: t.id,
    name: teamDisplayName(t),
    manager_names: (t.owners ?? [])
      .map((guid) => {
        const m = membersById.get(guid.toUpperCase());
        if (!m) return null;
        const full = [m.firstName, m.lastName].filter(Boolean).join(" ");
        return full || m.displayName || null;
      })
      .filter((n): n is string => n !== null),
  }));

  return {
    league_name: settings.name?.trim() || `League ${res.id}`,
    season: res.seasonId,
    team_count: settings.size ?? teams.length,
    scoring,
    roster,
    draft,
    teams,
  };
}

/** Contract rule for LeagueSummary.scoring_summary. */
export function scoringSummaryLabel(scoring: ScoringSnapshot, roster: RosterSnapshot): string {
  const hasReceiving = scoring.items.some((it) => RECEIVING_STAT_IDS.includes(it.statId));
  let tier: string;
  if (scoring.reception_points === null) {
    tier = hasReceiving ? "Standard" : "Custom scoring";
  } else if (scoring.reception_points === 1) {
    tier = "PPR";
  } else if (scoring.reception_points === 0.5) {
    tier = "0.5 PPR";
  } else if (scoring.reception_points === 0) {
    tier = "Standard";
  } else {
    tier = `${scoring.reception_points} pt/rec`;
  }
  return `${tier} · ${roster.starting_slots + roster.bench_slots} slots`;
}
