import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import ppr from "../fixtures/espn/settings-team.json";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5", NOW_OVERRIDE: "2026-08-15T12:00:00Z" };

async function setup() {
  const env = makeEnv(makeEspnStub({ "1001": ppr }, { kona, proTeams: proteams }), TEST_ENV);
  const cookie = await signInWithCreds(env, "detail@b.co");
  const league = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };
  await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
  return { env, cookie, leagueId: league.id };
}

describe("projection detail contract (US3, FR-014)", () => {
  it("breaks a projection into stat × value → points, consistent with the board", async () => {
    const { env, cookie, leagueId } = await setup();
    // Bo Rampart id 4429795: PPR oracle 295.0 (see scoring.test.ts).
    const res = await api(env, cookie, "GET", `/api/leagues/${leagueId}/board/players/4429795`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.total).toBe(295.0);
    expect(body.player.projected_points).toBe(295.0); // exactly equal (rounding rule)
    expect(body.player.position_rank).toBe(1);

    const rec = body.breakdown.find((b: { statId: number }) => b.statId === 53);
    expect(rec).toMatchObject({ label: "Receptions", projected: 48.0, points_per: 1, points: 48.0, covered: true });

    // One row per league scoring category; league categories only.
    const leagueStatIds = (ppr.settings.scoringSettings.scoringItems as { statId: number }[]).map((i) => i.statId);
    expect((body.breakdown as { statId: number }[]).map((b) => b.statId).sort()).toEqual([...leagueStatIds].sort());

    // Rounding rule: Σ displayed breakdown points ≈ total within ±0.05.
    const sum = (body.breakdown as { points: number }[]).reduce((s, b) => s + b.points, 0);
    expect(Math.abs(sum - body.total)).toBeLessThanOrEqual(0.05);
  });

  it("league categories the projection doesn't cover appear as zero, covered=false (FR-009)", async () => {
    const { env, cookie, leagueId } = await setup();
    // Vic Uprights (K): projects FG stats, but this league only scores XP (86) among kicker stats;
    // its passing/rushing categories are uncovered for him.
    const res = await api(env, cookie, "GET", `/api/leagues/${leagueId}/board/players/3055899`);
    const body = (await res.json()) as Record<string, any>;
    const passYds = body.breakdown.find((b: { statId: number }) => b.statId === 3);
    expect(passYds.covered).toBe(false);
    expect(passYds.points).toBe(0);
    expect(passYds.projected).toBeNull();
    expect(body.total).toBe(38.0); // 38 XP × 1
  });

  it("an unprojected player returns an empty breakdown and null total", async () => {
    const { env, cookie, leagueId } = await setup();
    const res = await api(env, cookie, "GET", `/api/leagues/${leagueId}/board/players/4991234`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.breakdown).toEqual([]);
    expect(body.total).toBeNull();
    expect(body.player.projected_points).toBeNull();
  });

  it("unknown or inactive players are 404 unknown_player", async () => {
    const { env, cookie, leagueId } = await setup();
    for (const id of [999999, 2330912]) {
      // 2330912 = Gus Hasbeen (inactive)
      const res = await api(env, cookie, "GET", `/api/leagues/${leagueId}/board/players/${id}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_player");
    }
  });
});
