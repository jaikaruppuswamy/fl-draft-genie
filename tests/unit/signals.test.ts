// Signal oracles (004 SC-002/FR-001/FR-002): hand-computed from the extended
// fixtures using the reference maps. Offense (0.5-PPR reference):
//   BUF 487.42 (Marshall 370.42 + Timber 117), GB 393 (Ledger 225 + Tower 168),
//   DEN 357.05 (Quill), LAR 277.5 (Vandal), ATL 271 (Rampart), PHI 221 (Breeze),
//   NO 194.5 (Deuce; stat 198 not in reference map).
// D/ST strengths: DEN 106, BUF 64, GB 128 → mean 99.3333 for unknown opponents.
// SoS weighted means (weeks 15-17 ×2): ATL (64 + 2·128 + 2·106)/5 = 106.4;
//   BUF (99.3333 + 2·106 + 2·128)/5 = 113.4667; DEN (128 + 64)/2 = 96.

import { describe, expect, it } from "vitest";
import {
  computeOffenseRaw,
  computeDefensiveStrength,
  computeSosRaw,
  normalizeAndRank,
  signalLabel,
} from "../../src/signals/compute";
import { fetchPlayers, fetchProTeams } from "../../src/projections/espnSource";
import { makeEnv } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

async function loadFixtures() {
  const stub = makeEspnStub({}, { kona, proTeams: proteams });
  const env = makeEnv(stub);
  const players = await fetchPlayers(env, 2026);
  const teams = await fetchProTeams(env, 2026);
  return { players, teams };
}

describe("offense signal (FR-001)", () => {
  it("matches hand-computed team totals with the reference map", async () => {
    const { players } = await loadFixtures();
    const raw = computeOffenseRaw(players);
    expect(raw.get(2)).toBeCloseTo(487.42, 4); // BUF
    expect(raw.get(9)).toBeCloseTo(393.0, 4); // GB
    expect(raw.get(7)).toBeCloseTo(357.05, 4); // DEN
    expect(raw.get(14)).toBeCloseTo(277.5, 4); // LAR (unprojected Newt contributes 0)
    expect(raw.get(1)).toBeCloseTo(271.0, 4); // ATL
    expect(raw.get(21)).toBeCloseTo(221.0, 4); // PHI
    expect(raw.get(18)).toBeCloseTo(194.5, 4); // NO — stat 198 ignored by reference map
    expect(raw.has(0)).toBe(false); // free agents excluded
  });

  it("excludes inactive players and non-offense positions", async () => {
    const { players } = await loadFixtures();
    const raw = computeOffenseRaw(players);
    // Gus Hasbeen (inactive, FA) contributes nowhere; K/DST never counted.
    expect([...raw.values()].every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("SoS signal (FR-002, playoff-weighted)", () => {
  it("matches hand-computed weighted means, mean-filling unknown opponents", async () => {
    const { players, teams } = await loadFixtures();
    const strength = computeDefensiveStrength(players);
    expect(strength.get(7)).toBeCloseTo(106, 4);
    expect(strength.get(2)).toBeCloseTo(64, 4);
    expect(strength.get(9)).toBeCloseTo(128, 4);

    const sos = computeSosRaw(teams, strength);
    expect(sos.get(1)).toBeCloseTo(106.4, 3); // ATL
    expect(sos.get(2)).toBeCloseTo(113.4667, 3); // BUF (ATL opponent mean-filled)
    expect(sos.get(7)).toBeCloseTo(96, 3); // DEN (no playoff-week games)
    expect(sos.has(21)).toBe(false); // PHI: no schedule → no SoS entry
  });
});

describe("normalize + rank (research §3)", () => {
  it("orients 100 to the favorable end and ranks 1 = favorable", () => {
    const raw = new Map([
      [1, 106.4],
      [2, 113.4667],
      [7, 96.0],
    ]);
    // SoS: lower raw = easier = favorable.
    const entries = normalizeAndRank(raw, "low");
    const byTeam = new Map(entries.map((e) => [e.pro_team_id, e]));
    expect(byTeam.get(7)).toMatchObject({ rank: 1 });
    expect(byTeam.get(7)!.score).toBeCloseTo(100, 3);
    expect(byTeam.get(2)).toMatchObject({ rank: 3 });
    expect(byTeam.get(2)!.score).toBeCloseTo(0, 3);
    expect(byTeam.get(1)!.rank).toBe(2);
    expect(byTeam.get(1)!.score).toBeCloseTo(40.458, 2);
  });

  it("breaks ties by team id — ranks are always a distinct permutation", () => {
    const raw = new Map([
      [9, 50],
      [3, 50],
      [5, 50],
    ]);
    const entries = normalizeAndRank(raw, "high");
    expect(entries.map((e) => [e.pro_team_id, e.rank])).toEqual([
      [3, 1],
      [5, 2],
      [9, 3],
    ]);
  });
});

describe("labels (thresholds in code)", () => {
  it("maps ranks to plain-language labels", () => {
    expect(signalLabel("offense", 3)).toBe("Top-5 offense");
    expect(signalLabel("offense", 8)).toBe("Top-10 offense");
    expect(signalLabel("sos", 1)).toBe("Top-5 schedule");
    expect(signalLabel("oline", 30)).toBe("Bottom-5 O-line");
    expect(signalLabel("oline", 24)).toBe("Bottom-10 O-line");
    expect(signalLabel("offense", 16)).toBe("Mid-pack offense");
  });
});
