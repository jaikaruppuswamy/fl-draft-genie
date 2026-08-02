import { describe, expect, it } from "vitest";
import { api, makeEnv, signIn, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import ppr from "../fixtures/espn/settings-team.json";
import odd from "../fixtures/espn/settings-odd.json";

describe("league connect contract (contracts/api.md)", () => {
  it("connects by numeric id with auto team match → 201 detail", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const res = await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.name).toBe("Gridiron Gurus");
    expect(body.my_team).toEqual({ espn_team_id: 4, name: "Jai's Giants" });
    expect(body.scoring_summary).toBe("PPR · 16 slots");
    expect(body.draft.supported).toBe(true);
    expect(body.draft.order_published).toBe(false);
    expect(body.scoring_rules.length).toBeGreaterThan(0);
  });

  it("connects by pasted ESPN URL", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const res = await api(env, cookie, "POST", "/api/leagues", {
      league_ref: "https://fantasy.espn.com/football/league?leagueId=1001&seasonId=2026",
    });
    expect(res.status).toBe(201);
  });

  it("requires credentials first (422 no_credentials)", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const cookie = await signIn(env, "u@b.co");
    const res = await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("no_credentials");
  });

  it("manual team pick: 409 with connect_token → connect/complete → 201", async () => {
    const env = makeEnv(makeEspnStub({ "3003": odd }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const first = await api(env, cookie, "POST", "/api/leagues", { league_ref: "3003" });
    expect(first.status).toBe(409);
    const choice = (await first.json()) as { error: string; connect_token: string; teams: { espn_team_id: number }[] };
    expect(choice.error).toBe("team_choice_required");
    expect(choice.teams.map((t) => t.espn_team_id)).toEqual([1, 2]);
    const done = await api(env, cookie, "POST", "/api/leagues/connect/complete", {
      connect_token: choice.connect_token,
      espn_team_id: 2,
    });
    expect(done.status).toBe(201);
    const body = (await done.json()) as { my_team: { espn_team_id: number } };
    expect(body.my_team.espn_team_id).toBe(2);
  });

  it("rejects a team id not in the league (422 invalid_team)", async () => {
    const env = makeEnv(makeEspnStub({ "3003": odd }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const first = await api(env, cookie, "POST", "/api/leagues", { league_ref: "3003" });
    const choice = (await first.json()) as { connect_token: string };
    const res = await api(env, cookie, "POST", "/api/leagues/connect/complete", {
      connect_token: choice.connect_token,
      espn_team_id: 99,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_team");
  });

  it("rejects a forged/expired connect token", async () => {
    const env = makeEnv(makeEspnStub({ "3003": odd }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const res = await api(env, cookie, "POST", "/api/leagues/connect/complete", {
      connect_token: "forged.token",
      espn_team_id: 1,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("expired_connect_token");
  });

  it("maps each validation failure to its distinct code (FR-012)", async () => {
    const wrongSeason = structuredClone(ppr) as Record<string, any>;
    wrongSeason.seasonId = 2025;
    const notFootball = structuredClone(ppr) as Record<string, any>;
    notFootball.gameId = 2;
    const env = makeEnv(
      makeEspnStub({ "1001": ppr, "5000": wrongSeason, "6000": notFootball }),
    );
    const cookie = await signInWithCreds(env, "u@b.co");

    const cases: [unknown, number, string][] = [
      [{ league_ref: "zzz" }, 422, "unparseable_ref"],
      [{ league_ref: "424242" }, 422, "league_not_found"],
      [{ league_ref: "5000" }, 422, "wrong_season"],
      [{ league_ref: "6000" }, 422, "not_football"],
    ];
    for (const [body, status, code] of cases) {
      const res = await api(env, cookie, "POST", "/api/leagues", body);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }

    expect((await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).status).toBe(201);
    const dup = await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    expect(dup.status).toBe(422);
    expect(((await dup.json()) as { error: string }).error).toBe("already_connected");
  });

  it("ESPN unreachable during connect → 502, no partial connection", async () => {
    const env = makeEnv(makeEspnStub({ "1001": "network" }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const res = await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    expect(res.status).toBe(502);
    const list = await api(env, cookie, "GET", "/api/leagues");
    expect(((await list.json()) as { leagues: unknown[] }).leagues).toHaveLength(0);
  });
});
