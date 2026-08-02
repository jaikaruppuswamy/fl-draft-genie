import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import ppr from "../fixtures/espn/settings-team.json";
import half from "../fixtures/espn/settings-team-half.json";

function withNoDraftDate(id: number): object {
  const clone = structuredClone(ppr) as Record<string, any>;
  clone.id = id;
  clone.settings.name = "No Date League";
  delete clone.settings.draftSettings.date;
  return clone;
}

describe("dashboard list + delete contract", () => {
  it("orders leagues by soonest draft, no-date leagues last (FR-021)", async () => {
    // ppr drafts before half (fixture dates 1h apart); 7007 has no date.
    const env = makeEnv(makeEspnStub({ "1001": ppr, "2002": half, "7007": withNoDraftDate(7007) }));
    const cookie = await signInWithCreds(env, "u@b.co");
    for (const ref of ["7007", "2002", "1001"]) {
      expect((await api(env, cookie, "POST", "/api/leagues", { league_ref: ref })).status).toBe(201);
    }
    const res = await api(env, cookie, "GET", "/api/leagues");
    const body = (await res.json()) as { leagues: { name: string }[] };
    expect(body.leagues.map((l) => l.name)).toEqual([
      "Gridiron Gurus",
      "Naperville Nine",
      "No Date League",
    ]);
  });

  it("DELETE removes the connection; other leagues intact (FR-015)", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr, "2002": half }));
    const cookie = await signInWithCreds(env, "u@b.co");
    const a = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "2002" });
    expect((await api(env, cookie, "DELETE", `/api/leagues/${a.id}`)).status).toBe(204);
    const list = (await (await api(env, cookie, "GET", "/api/leagues")).json()) as { leagues: { name: string }[] };
    expect(list.leagues.map((l) => l.name)).toEqual(["Naperville Nine"]);
  });

  it("cross-account access is 404, never data (FR-003)", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const cookieA = await signInWithCreds(env, "a@b.co");
    const league = (await (await api(env, cookieA, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };
    const cookieB = await signInWithCreds(env, "b@b.co");
    for (const [method, path] of [
      ["GET", `/api/leagues/${league.id}`],
      ["POST", `/api/leagues/${league.id}/sync`],
      ["DELETE", `/api/leagues/${league.id}`],
    ] as const) {
      const res = await api(env, cookieB, method, path);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_league");
    }
    // A's league untouched by B's delete attempt.
    const list = (await (await api(env, cookieA, "GET", "/api/leagues")).json()) as { leagues: unknown[] };
    expect(list.leagues).toHaveLength(1);
  });
});
