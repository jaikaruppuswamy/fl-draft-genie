import { describe, expect, it } from "vitest";
import { api, makeEnv, MY_S2, MY_SWID, signIn } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import ppr from "../fixtures/espn/settings-team.json";

describe("credentials contract (contracts/api.md)", () => {
  it("PUT normalizes pasted values, validates against ESPN, and returns only masked data", async () => {
    const stub = makeEspnStub();
    const env = makeEnv(stub);
    const cookie = await signIn(env, "c@b.co");
    const res = await api(env, cookie, "PUT", "/api/credentials", {
      espn_s2: `  "${MY_S2}" `,
      swid: "11111111-2222-3333-4444-555555555555", // no braces, pasted bare
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("working");
    expect(body.swid_masked).toBe("{1111…5555}");
    expect(body.leagues_revalidated).toBe(0);
    expect(JSON.stringify(body)).not.toContain(MY_S2);
    // The ESPN probe received the normalized cookie header.
    expect(stub.requests[0]!.cookie).toContain(`SWID=${MY_SWID}`);
  });

  it("PUT rejects malformed values without calling ESPN or storing anything", async () => {
    const stub = makeEspnStub();
    const env = makeEnv(stub);
    const cookie = await signIn(env, "c@b.co");
    const res = await api(env, cookie, "PUT", "/api/credentials", { espn_s2: "short", swid: "junk" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("malformed_credentials");
    expect(stub.requests).toHaveLength(0);
    const get = await api(env, cookie, "GET", "/api/credentials");
    expect(((await get.json()) as { present: boolean }).present).toBe(false);
  });

  it("PUT surfaces ESPN rejection as 422 espn_rejected and stores nothing", async () => {
    const stub = makeEspnStub();
    stub.credsResponse = 401;
    const env = makeEnv(stub);
    const cookie = await signIn(env, "c@b.co");
    const res = await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("espn_rejected");
    expect(body.message).toMatch(/fresh|expired|copy/i); // actionable (SC-006)
    const get = await api(env, cookie, "GET", "/api/credentials");
    expect(((await get.json()) as { present: boolean }).present).toBe(false);
  });

  it("PUT returns 502 espn_unreachable on network failure, nothing stored", async () => {
    const stub = makeEspnStub();
    stub.credsResponse = "network";
    const env = makeEnv(stub);
    const cookie = await signIn(env, "c@b.co");
    const res = await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("espn_unreachable");
  });

  it("replacing credentials re-validates every connected league (FR-007)", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const cookie = await signIn(env, "c@b.co");
    await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
    const connect = await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    expect(connect.status).toBe(201);
    const replace = await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2 + "x", swid: MY_SWID });
    expect(replace.status).toBe(200);
    const body = (await replace.json()) as { leagues_revalidated: number; status: string };
    expect(body.leagues_revalidated).toBe(1);
    expect(body.status).toBe("working");
  });

  it("GET reports masked state only", async () => {
    const env = makeEnv(makeEspnStub());
    const cookie = await signIn(env, "c@b.co");
    await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
    const res = await api(env, cookie, "GET", "/api/credentials");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.present).toBe(true);
    expect(body.status).toBe("working");
    expect(body.swid_masked).toBe("{1111…5555}");
    expect(JSON.stringify(body)).not.toContain("2222-3333");
  });
});
