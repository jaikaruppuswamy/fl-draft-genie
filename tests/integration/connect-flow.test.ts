// US1 end-to-end: sign in → store cookies → connect league → settings match
// the ESPN fixture category-for-category (SC-002). Plus account deletion (FR-009).

import { describe, expect, it } from "vitest";
import { api, app, makeEnv, MY_S2, MY_SWID, signIn } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import ppr from "../fixtures/espn/settings-team.json";
import type { EspnLeagueResponse } from "../../src/espn/types";

describe("US1: connect an ESPN league", () => {
  it("full journey lands a league whose settings mirror ESPN exactly", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const cookie = await signIn(env, "jai@example.com");

    const creds = await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
    expect(creds.status).toBe(200);

    const connect = await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    expect(connect.status).toBe(201);
    const league = (await connect.json()) as Record<string, any>;

    const detail = (await (await api(env, cookie, "GET", `/api/leagues/${league.id}`)).json()) as Record<string, any>;
    const fixtureItems = (ppr as EspnLeagueResponse).settings!.scoringSettings!.scoringItems!;
    // SC-002: every scored stat category matches, count and value.
    expect(detail.scoring_rules).toHaveLength(fixtureItems.length);
    for (const item of fixtureItems) {
      const got = (detail.scoring_rules as { statId: number; points: number }[]).find(
        (r) => r.statId === item.statId,
      );
      expect(got?.points).toBe(item.points);
    }
    expect(detail.team_count).toBe(12);
    expect(detail.roster_slots.find((s: { label: string }) => s.label === "Bench").count).toBe(7);
    expect(detail.my_team.name).toBe("Jai's Giants");
    expect(detail.teams).toHaveLength(3);
    expect(detail.draft.scheduled_at).toBe(new Date(1788486000000).toISOString());
  });

  it("account deletion removes credentials and leagues (FR-009)", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const cookie = await signIn(env, "gone@example.com");
    await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });

    const del = await api(env, cookie, "DELETE", "/api/account");
    expect(del.status).toBe(204);
    expect(del.headers.get("Set-Cookie")).toContain("dg_session=;");

    // The old session token references a dead account — everything is gone.
    const cookie2 = await signIn(env, "gone@example.com");
    const creds = (await (await api(env, cookie2, "GET", "/api/credentials")).json()) as { present: boolean };
    expect(creds.present).toBe(false);
    const leagues = (await (await api(env, cookie2, "GET", "/api/leagues")).json()) as { leagues: unknown[] };
    expect(leagues.leagues).toHaveLength(0);
    // No orphan rows survived the cascade.
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM league_snapshots").first<{ n: number }>();
    expect(orphans?.n).toBe(0);
    void app;
  });
});
