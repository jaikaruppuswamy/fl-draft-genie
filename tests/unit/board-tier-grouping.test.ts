// 016 — an untiered player is not a badly-tiered one.
//
// Reported as "Lamar is in tier 8, Dak Prescott is in tier 1". Both halves were
// true on screen and neither was a tiering error:
//
//   * Dak really is tier 1 in the upstream feed — verified against
//     `text_QB.txt`, which we parse correctly;
//   * Lamar is not in that feed AT ALL, so his tier is null. Untiered players
//     sort last, after the highest tier, and the divider only rendered when
//     `tier !== null` — so they appeared beneath the last heading shown.
//
// The distinction is the point. "Worst tier" is a ranking; "untiered" means the
// source has no opinion, which is the difference between advice and an absence
// of advice — and this codebase's standing rule is that an unknown is reported
// as unknown rather than rendered as a value.

import { describe, expect, it } from "vitest";

interface Row {
  espn_player_id: number;
  tier: number | null;
  projected_points: number;
}

/** The board's grouped ordering: tier ascending, untiered last, points within. */
function ordered(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ta = a.tier ?? Infinity;
    const tb = b.tier ?? Infinity;
    if (ta !== tb) return ta - tb;
    return b.projected_points - a.projected_points;
  });
}

/** Where a divider is emitted, and what it says. */
function dividers(rows: Row[]): string[] {
  const out: string[] = [];
  rows.forEach((p, i) => {
    const prev = i > 0 ? rows[i - 1]! : null;
    if (prev === null || prev.tier !== p.tier) out.push(p.tier !== null ? `Tier ${p.tier}` : "Not tiered");
  });
  return out;
}

const rows: Row[] = [
  { espn_player_id: 1, tier: 1, projected_points: 320 }, // Dak, per the real feed
  { espn_player_id: 2, tier: 1, projected_points: 315 },
  { espn_player_id: 3, tier: 8, projected_points: 180 },
  { espn_player_id: 4, tier: null, projected_points: 400 }, // Lamar: absent upstream
  { espn_player_id: 5, tier: null, projected_points: 390 },
];

describe("untiered players get their own heading", () => {
  it("emits a divider when the tier becomes null", () => {
    // The defect: no divider here, so these rows sat under "Tier 8".
    expect(dividers(ordered(rows))).toEqual(["Tier 1", "Tier 8", "Not tiered"]);
  });

  it("PROVES the check can fail — the old rule skipped that boundary", () => {
    const old = (list: Row[]): string[] => {
      const out: string[] = [];
      list.forEach((p, i) => {
        const prev = i > 0 ? list[i - 1]! : null;
        if (p.tier !== null && (prev === null || prev.tier !== p.tier)) out.push(`Tier ${p.tier}`);
      });
      return out;
    };
    expect(old(ordered(rows))).toEqual(["Tier 1", "Tier 8"]);
  });

  it("still sorts untiered players LAST, whatever they project", () => {
    // Deliberate: the tier source outranks projection in grouped mode, so a
    // player it does not rank cannot jump the tiered ones — even projecting
    // higher than all of them, as Lamar does.
    const o = ordered(rows);
    expect(o.at(-1)!.tier).toBeNull();
    expect(o[0]!.tier).toBe(1);
  });

  it("orders untiered players among themselves by projection", () => {
    const untiered = ordered(rows).filter((r) => r.tier === null);
    expect(untiered.map((r) => r.espn_player_id)).toEqual([4, 5]);
  });

  it("emits no untiered heading when every player is tiered", () => {
    // A league whose feed covers everyone must not grow a spurious section.
    const full = rows.filter((r) => r.tier !== null);
    expect(dividers(ordered(full))).toEqual(["Tier 1", "Tier 8"]);
  });
});
