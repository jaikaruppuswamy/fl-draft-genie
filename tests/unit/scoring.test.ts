// SC-002 scoring oracles: expected points hand-computed from the fixture stat
// lines and each league's scoring map. If kona-players.json changes, recompute
// these by hand (see fixtures README).

import { describe, expect, it } from "vitest";
import { scoreStatLine, buildLeagueBoard } from "../../src/projections/scoring";
import type { ScoringSnapshot } from "../../src/espn/parsers";
import ppr from "../fixtures/espn/settings-team.json";

// The PPR league fixture's scoring: 3:0.04 4:4 20:-2 24:0.1 25:6 42:0.1 43:6 53:1 72:-2 86:1 99:1
const PPR_ITEMS = (ppr.settings.scoringSettings.scoringItems as { statId: number; points: number }[]).map(
  (i) => ({ ...i, label: `Stat #${i.statId}` }),
);
const HALF_ITEMS = PPR_ITEMS.map((i) => (i.statId === 53 ? { ...i, points: 0.5 } : i));
const STD_ITEMS = PPR_ITEMS.map((i) => (i.statId === 53 ? { ...i, points: 0 } : i));

const BO = { "24": 1250.0, "25": 11.0, "42": 410.0, "43": 3.0, "53": 48.0, "72": 1.5 };
const MARSHALL = { "3": 4750.5, "4": 38.2, "20": 11.5, "24": 320.0, "25": 3.1 };
const QUILL = { "3": 4100.0, "4": 30.0, "20": 9.0, "24": 550.5, "25": 6.0 };

describe("scoreStatLine (FR-008/FR-009, SC-002 oracles)", () => {
  it("matches hand-computed totals in PPR", () => {
    // Bo Rampart: 125 + 66 + 41 + 18 + 48 - 3 = 295.0
    expect(scoreStatLine(BO, PPR_ITEMS).total).toBeCloseTo(295.0, 5);
    // Max Marshall: 190.02 + 152.8 - 23 + 32 + 18.6 = 370.42
    expect(scoreStatLine(MARSHALL, PPR_ITEMS).total).toBeCloseTo(370.42, 5);
    // Jordan Quill: 164 + 120 - 18 + 55.05 + 36 = 357.05
    expect(scoreStatLine(QUILL, PPR_ITEMS).total).toBeCloseTo(357.05, 5);
  });

  it("matches hand-computed totals in half-PPR and standard (league currency differs)", () => {
    expect(scoreStatLine(BO, HALF_ITEMS).total).toBeCloseTo(271.0, 5); // 295 - 48*0.5
    expect(scoreStatLine(BO, STD_ITEMS).total).toBeCloseTo(247.0, 5); // 295 - 48
  });

  it("uncovered league categories contribute zero and are flagged (FR-009)", () => {
    const withBonus = [...PPR_ITEMS, { statId: 199, points: 2, label: "Custom Bonus" }];
    const { breakdown, total } = scoreStatLine(BO, withBonus);
    const bonus = breakdown.find((b) => b.statId === 199)!;
    expect(bonus.covered).toBe(false);
    expect(bonus.points).toBe(0);
    expect(bonus.projected).toBeNull();
    expect(total).toBeCloseTo(295.0, 5); // unchanged
  });

  it("projected categories the league does not score are omitted from the breakdown", () => {
    const rio = { "24": 620.0, "53": 61.0, "198": 12.0 };
    const { breakdown } = scoreStatLine(rio, PPR_ITEMS);
    expect(breakdown.find((b) => b.statId === 198)).toBeUndefined();
  });

  it("unprojected players yield null total and empty breakdown", () => {
    const { total, breakdown } = scoreStatLine(null, PPR_ITEMS);
    expect(total).toBeNull();
    expect(breakdown).toEqual([]);
  });

  it("breakdown line points are display-rounded; total is round1 of the unrounded sum", () => {
    const { total, breakdown } = scoreStatLine(MARSHALL, PPR_ITEMS);
    expect(total).toBeCloseTo(370.42, 5); // unrounded here; API rounds
    const sumOfDisplayed = breakdown.reduce((s, b) => s + b.points, 0);
    expect(Math.abs(sumOfDisplayed - Math.round(total! * 10) / 10)).toBeLessThanOrEqual(0.05 * breakdown.length);
  });
});

describe("buildLeagueBoard (FR-011/FR-013)", () => {
  const universe = [
    { espn_player_id: 1, full_name: "Bo", primary_position: "RB", eligible_positions: '["RB"]', team_abbrev: "ATL", bye_week: 12, adpStats: BO },
    { espn_player_id: 2, full_name: "Marshall", primary_position: "QB", eligible_positions: '["QB"]', team_abbrev: "BUF", bye_week: 7, adpStats: MARSHALL },
    { espn_player_id: 3, full_name: "Quill", primary_position: "QB", eligible_positions: '["QB"]', team_abbrev: "DEN", bye_week: 9, adpStats: QUILL },
    { espn_player_id: 4, full_name: "Zed Rookie", primary_position: "WR", eligible_positions: '["WR"]', team_abbrev: "LAR", bye_week: 6, adpStats: null },
  ];
  const players = universe.map((u) => ({
    espn_player_id: u.espn_player_id,
    full_name: u.full_name,
    primary_position: u.primary_position,
    eligible_positions: u.eligible_positions,
    pro_team_id: 0,
    active: 1,
    injury_status: null,
    updated_at: "2026-08-15T00:00:00Z",
    team_abbrev: u.team_abbrev,
    bye_week: u.bye_week,
  }));
  const projections = universe
    .filter((u) => u.adpStats)
    .map((u) => ({
      set_id: "s1",
      espn_player_id: u.espn_player_id,
      stats_json: JSON.stringify(u.adpStats),
      adp: u.espn_player_id * 1.5,
      overall_rank: u.espn_player_id,
    }));

  it("sorts by points desc, assigns per-position ranks, unprojected tail", () => {
    const scoring: ScoringSnapshot["items"] = PPR_ITEMS;
    const board = buildLeagueBoard(players, projections, scoring);
    expect(board.map((b) => b.name)).toEqual(["Marshall", "Quill", "Bo", "Zed Rookie"]);
    expect(board[0]!.projected_points).toBe(370.4); // round1(370.42)
    expect(board[1]!.projected_points).toBe(357.1); // round1(357.05) half-up
    expect(board[0]!.position_rank).toBe(1); // QB1
    expect(board[1]!.position_rank).toBe(2); // QB2
    expect(board[2]!.position_rank).toBe(1); // RB1
    expect(board[3]!.projected_points).toBeNull();
    expect(board[3]!.position_rank).toBeNull();
  });
});
