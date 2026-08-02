// US4: same account from a second device — full dashboard, zero ESPN
// credential re-entry (SC-007).

import { describe, expect, it } from "vitest";
import { api, makeEnv, signIn, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import ppr from "../fixtures/espn/settings-team.json";

describe("US4: return on any device", () => {
  it("second sign-in sees the same leagues without re-entering cookies", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    const deviceA = await signInWithCreds(env, "same@person.co");
    await api(env, deviceA, "POST", "/api/leagues", { league_ref: "1001" });

    const deviceB = await signIn(env, "same@person.co"); // fresh cookie jar
    expect(deviceB).not.toBe(deviceA);
    const creds = (await (await api(env, deviceB, "GET", "/api/credentials")).json()) as { present: boolean };
    expect(creds.present).toBe(true);
    const leagues = (await (await api(env, deviceB, "GET", "/api/leagues")).json()) as { leagues: { name: string }[] };
    expect(leagues.leagues.map((l) => l.name)).toEqual(["Gridiron Gurus"]);
  });

  it("a request with no session cookie gets 401 on every protected endpoint", async () => {
    const env = makeEnv(makeEspnStub({ "1001": ppr }));
    for (const [method, path] of [
      ["GET", "/api/leagues"],
      ["GET", "/api/credentials"],
      ["PUT", "/api/credentials"],
      ["POST", "/api/leagues"],
      ["DELETE", "/api/account"],
    ] as const) {
      const res = await api(env, "", method, path, method === "GET" ? undefined : {});
      expect(res.status).toBe(401);
    }
  });
});
