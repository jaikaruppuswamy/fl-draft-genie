import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import ppr from "../fixtures/espn/settings-team.json";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5", NOW_OVERRIDE: "2026-08-15T12:00:00Z" };

function standardLeague(id: number): object {
  const clone = structuredClone(ppr) as Record<string, any>;
  clone.id = id;
  clone.settings.name = "Standard League";
  clone.settings.scoringSettings.scoringItems.find((i: { statId: number }) => i.statId === 53)!.points = 0;
  return clone;
}

async function setup(env: ReturnType<typeof makeEnv>) {
  const cookie = await signInWithCreds(env, "board@b.co");
  const league = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };
  return { cookie, leagueId: league.id };
}

describe("board contract (contracts/api.md)", () => {
  it("409 no_projections before the first ingest", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }, { kona, proTeams: proteams }), TEST_ENV);
    const { cookie, leagueId } = await setup(env);
    const res = await api(env, cookie, "GET", `/api/leagues/${leagueId}/board`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_projections");
  });

  it("returns the full board: ordering, ranks, freshness, unprojected tail, inactive excluded", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }, { kona, proTeams: proteams }), TEST_ENV);
    const { cookie, leagueId } = await setup(env);
    await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));

    const res = await api(env, cookie, "GET", `/api/leagues/${leagueId}/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(body.freshness.fetched_at).toBe("2026-08-15T09:00:00.000Z");
    expect(body.freshness.stale).toBe(false); // 3h old in August

    const names = body.players.map((p: { name: string }) => p.name);
    // PPR oracle order (see scoring.test.ts); unprojected rookie last; inactive Gus absent.
    expect(names[0]).toBe("Max Marshall"); // 370.4
    expect(names[1]).toBe("Jordan Quill"); // 357.1
    expect(names[2]).toBe("Sky Vandal"); // 330.0
    expect(names[names.length - 1]).toBe("Newt Longshot");
    expect(names).not.toContain("Gus Hasbeen");

    const bo = body.players.find((p: { name: string }) => p.name === "Bo Rampart");
    expect(bo.projected_points).toBe(295.0);
    expect(bo.position_rank).toBe(1); // RB1
    expect(bo.team).toBe("ATL");
    expect(bo.bye_week).toBe(12);
    expect(bo.adp).toBe(2.3);

    const rookie = body.players.find((p: { name: string }) => p.name === "Newt Longshot");
    expect(rookie.projected_points).toBeNull();
    expect(rookie.position_rank).toBeNull();
    expect(rookie.adp).toBeNull();
  });

  it("SC-003: the same player scores differently in PPR vs standard leagues", async () => {
    const env = makeEnv(
      makeEspnStub({ "1001": ppr, "5005": standardLeague(5005) }, { kona, proTeams: proteams }),
      TEST_ENV,
    );
    const { cookie, leagueId } = await setup(env);
    const std = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "5005" })).json()) as { id: string };
    await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));

    const pprBoard = (await (await api(env, cookie, "GET", `/api/leagues/${leagueId}/board`)).json()) as Record<string, any>;
    const stdBoard = (await (await api(env, cookie, "GET", `/api/leagues/${std.id}/board`)).json()) as Record<string, any>;
    const pprBo = pprBoard.players.find((p: { name: string }) => p.name === "Bo Rampart");
    const stdBo = stdBoard.players.find((p: { name: string }) => p.name === "Bo Rampart");
    expect(pprBo.projected_points).toBe(295.0);
    expect(stdBo.projected_points).toBe(247.0); // 48 receptions × 1.0 removed
  });

  it("FR-010: a league scoring change re-scores the board with no new projection set", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }, { kona, proTeams: proteams }), TEST_ENV);
    const { cookie, leagueId } = await setup(env);
    await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));

    const before = (await (await api(env, cookie, "GET", `/api/leagues/${leagueId}/board`)).json()) as Record<string, any>;
    const boBefore = before.players.find((p: { name: string }) => p.name === "Bo Rampart");
    expect(boBefore.projected_points).toBe(295.0);

    // Simulate a 001 re-sync that halves the reception value in the snapshot.
    const snapshot = await env.DB.prepare(
      "SELECT scoring_json FROM league_snapshots WHERE connection_id = ?",
    )
      .bind(leagueId)
      .first<{ scoring_json: string }>();
    const scoring = JSON.parse(snapshot!.scoring_json);
    scoring.items.find((i: { statId: number }) => i.statId === 53)!.points = 0.5;
    await env.DB.prepare("UPDATE league_snapshots SET scoring_json = ? WHERE connection_id = ?")
      .bind(JSON.stringify(scoring), leagueId)
      .run();

    const after = (await (await api(env, cookie, "GET", `/api/leagues/${leagueId}/board`)).json()) as Record<string, any>;
    const boAfter = after.players.find((p: { name: string }) => p.name === "Bo Rampart");
    expect(boAfter.projected_points).toBe(271.0); // instant, same projection set
    expect(after.freshness.fetched_at).toBe(before.freshness.fetched_at);
  });

  it("cross-account and unknown leagues are 404", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }, { kona, proTeams: proteams }), TEST_ENV);
    const { leagueId } = await setup(env);
    const other = await signInWithCreds(env, "other@b.co");
    const res = await api(env, other, "GET", `/api/leagues/${leagueId}/board`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_league");
  });
});
