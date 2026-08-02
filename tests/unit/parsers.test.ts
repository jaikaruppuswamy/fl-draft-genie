import { describe, expect, it } from "vitest";
import { parseLeague, scoringSummaryLabel } from "../../src/espn/parsers";
import type { EspnLeagueResponse } from "../../src/espn/types";
import ppr from "../fixtures/espn/settings-team.json";
import half from "../fixtures/espn/settings-team-half.json";
import odd from "../fixtures/espn/settings-odd.json";
import published from "../fixtures/espn/draftdetail-published.json";

describe("ESPN league parsing (constitution III: lossless scoring)", () => {
  it("keeps every scoring item with its exact point value", () => {
    const parsed = parseLeague(ppr as EspnLeagueResponse);
    const fixtureItems = (ppr as EspnLeagueResponse).settings!.scoringSettings!.scoringItems!;
    expect(parsed.scoring.items).toHaveLength(fixtureItems.length);
    for (const item of fixtureItems) {
      expect(parsed.scoring.items.find((i) => i.statId === item.statId)?.points).toBe(item.points);
    }
    expect(parsed.scoring.reception_points).toBe(1);
    expect(parsed.scoring.items.find((i) => i.statId === 53)?.label).toBe("Receptions");
  });

  it("parses roster composition with starters vs bench split", () => {
    const parsed = parseLeague(ppr as EspnLeagueResponse);
    expect(parsed.roster.bench_slots).toBe(7);
    // 1 QB + 2 RB + 2 WR + 1 TE + 1 D/ST + 1 K + 1 FLEX = 9 starters (bench/IR excluded)
    expect(parsed.roster.starting_slots).toBe(9);
  });

  it("parses draft settings: unpublished order is null, published is a team-id list", () => {
    const before = parseLeague(ppr as EspnLeagueResponse);
    expect(before.draft.order).toBeNull();
    expect(before.draft.supported).toBe(true);
    expect(before.draft.scheduled_at).toBe(new Date(1788486000000).toISOString());
    const after = parseLeague(published as EspnLeagueResponse);
    expect(after.draft.order).toEqual([4, 1, 7, 2, 5, 3, 6, 8, 9, 10, 11, 12]);
  });

  it("builds team names from name or location+nickname and resolves managers", () => {
    const parsed = parseLeague(ppr as EspnLeagueResponse);
    expect(parsed.teams.map((t) => t.name)).toEqual(["Bench Warmers", "Jai's Giants", "End Zone Elite"]);
    expect(parsed.teams[1]!.manager_names).toEqual(["Jai K"]);
  });

  it("parses the odd-shape league (tiny, no bench, auction) without error", () => {
    const parsed = parseLeague(odd as EspnLeagueResponse);
    expect(parsed.team_count).toBe(4);
    expect(parsed.roster.bench_slots).toBe(0);
    expect(parsed.draft.supported).toBe(false); // auction — not snake
    expect(parsed.draft.scheduled_at).toBeNull();
  });
});

describe("scoring_summary label (contracts/api.md)", () => {
  it("labels PPR tiers and slot counts", () => {
    const p = parseLeague(ppr as EspnLeagueResponse);
    expect(scoringSummaryLabel(p.scoring, p.roster)).toBe("PPR · 16 slots");
    const h = parseLeague(half as EspnLeagueResponse);
    expect(scoringSummaryLabel(h.scoring, h.roster)).toBe("0.5 PPR · 16 slots");
    const o = parseLeague(odd as EspnLeagueResponse);
    // Receiving stats present but no reception item → Standard.
    expect(scoringSummaryLabel(o.scoring, o.roster)).toBe("Standard · 4 slots");
  });
});
