// 011 T026/T028/T029/T032 — the enablement handshake, end to end.
//
// The property worth testing is that NEITHER HALF IS SUFFICIENT:
//
//   * a claim stolen by a same-origin script is useless without the nonce, and
//     the page never had the nonce;
//   * a nonce is useless without a claim, and only a signed-in session can mint
//     one.
//
// That is the whole difference from the flow being replaced, where one
// same-origin `fetch` returned a 180-day bearer with no second factor at all.

import { beforeEach, describe, expect, it } from "vitest";
import { app, makeEnv, signIn } from "../helpers/app";
import { sha256Hex } from "../../src/db/client";
import type { Env } from "../../src/env";

let env: Env;
let cookie: string;

const NONCE = "a".repeat(64);

beforeEach(async () => {
  env = makeEnv();
  cookie = await signIn(env, "enable@test.co");
});

async function claim(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.request(
    "/api/tap-pairings/enable/claim",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
      body: JSON.stringify({ commit: await sha256Hex(NONCE), ...over }),
    },
    env,
  );
}

async function redeem(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request(
    "/api/tap/enable/redeem",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** The happy path, as the page and script together would walk it. */
async function enable(): Promise<{ status: string; token?: string; pairing_id?: string }> {
  const c = await claim();
  const { claim_id } = (await c.json()) as { claim_id: string };
  const r = await redeem({ claim: claim_id, nonce: NONCE });
  return (await r.json()) as { status: string; token?: string; pairing_id?: string };
}

describe("the claim half requires a session (FR-019)", () => {
  it("401s without one", async () => {
    const res = await app.request(
      "/api/tap-pairings/enable/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: await sha256Hex(NONCE) }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("mints a claim WITH one — PROVES the route is reachable at all", async () => {
    // Without this, the 401 above passes against a route that does not exist,
    // which is the specific failure mode of mounting it on the wrong side of
    // the session middleware.
    expect((await claim()).status).toBe(201);
  });

  it("hands back no credential — only an opaque handle (FR-017)", async () => {
    const body = (await (await claim()).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["claim_id"]);
    expect(JSON.stringify(body)).not.toContain(NONCE);
  });
});

describe("the redeem half requires the preimage the page never had", () => {
  it("REFUSES a claim redeemed with the wrong nonce", async () => {
    // The page-steals-the-claim attack. This is the assertion that makes the
    // split worth having.
    const { claim_id } = (await (await claim()).json()) as { claim_id: string };
    const res = await redeem({ claim: claim_id, nonce: "b".repeat(64) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_preimage");
  });

  it("REFUSES an unknown claim", async () => {
    const res = await redeem({ claim: "nope", nonce: NONCE });
    expect(((await res.json()) as { error: string }).error).toBe("no_claim");
  });

  it("REFUSES a claim twice — single use", async () => {
    const { claim_id } = (await (await claim()).json()) as { claim_id: string };
    expect((await redeem({ claim: claim_id, nonce: NONCE })).status).toBe(200);

    const second = await redeem({ claim: claim_id, nonce: NONCE });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("claim_used");
  });

  it("mints on a correct preimage — PROVES the refusals are conditional", async () => {
    const body = await enable();
    expect(body.status).toBe("enabled");
    expect(body.token).toBeTruthy();
  });

  it("needs NO session cookie — the script has none and must not", async () => {
    // The mounting trap: behind the session middleware this returns 401
    // however correct the preimage is.
    const { claim_id } = (await (await claim()).json()) as { claim_id: string };
    const res = await redeem({ claim: claim_id, nonce: NONCE });
    expect(res.status).toBe(200);
  });
});

describe("re-acknowledging is safe (FR-020)", () => {
  it("mints NOTHING when this browser already holds a working credential", async () => {
    // The relay in progress must not be interrupted, and a second click must
    // not pile up pairings. Evidence, not a promise: the script presents the
    // bearer it holds and the server verifies it.
    const first = await enable();
    expect(first.status).toBe("enabled");

    const c = await claim();
    const { claim_id } = (await c.json()) as { claim_id: string };
    const res = await redeem(
      { claim: claim_id, nonce: NONCE },
      { Authorization: `Bearer ${first.token}`, "X-Tap-Install": "install-1" },
    );
    const body = (await res.json()) as { status: string; token?: string };
    expect(body.status).toBe("already_enabled");
    expect(body.token).toBeUndefined();
  });

  it("leaves the FIRST credential working", async () => {
    // The literal reading of "must not interrupt a relay in progress".
    const first = await enable();
    const c = await claim();
    const { claim_id } = (await c.json()) as { claim_id: string };
    await redeem(
      { claim: claim_id, nonce: NONCE },
      { Authorization: `Bearer ${first.token}`, "X-Tap-Install": "install-1" },
    );

    const { verifyPairing } = await import("../../src/db/tap");
    const check = await verifyPairing(env.DB, first.token!, "install-1", new Date());
    expect(check.ok).toBe(true);
  });
});

describe("enablement outlives the session (FR-020a)", () => {
  it("keeps working after sign-out", async () => {
    // A draft outlasts a session, and under league-shared delivery a relay
    // dying mid-draft takes the whole league's feed with it. So the credential
    // is a property of the BROWSER, not of a signed-in session.
    const { token } = await enable();
    await app.request("/api/auth/signout", { method: "POST", headers: { Cookie: cookie } }, env);

    // An install id is passed because `verifyPairing` REQUIRES one: omitting
    // the header must not skip the binding check, so `null` fails for a reason
    // that has nothing to do with sign-out.
    const { verifyPairing } = await import("../../src/db/tap");
    expect((await verifyPairing(env.DB, token!, "install-1", new Date())).ok).toBe(true);
  });

  it("stays revocable — PROVES surviving sign-out is not the same as permanent", async () => {
    const { token, pairing_id } = await enable();
    const res = await app.request(
      `/api/tap-pairings/${pairing_id}`,
      { method: "DELETE", headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBeLessThan(300);

    const { verifyPairing } = await import("../../src/db/tap");
    expect((await verifyPairing(env.DB, token!, "install-1", new Date())).ok).toBe(false);
  });
});

describe("the ingest still rejects unattributable frames (T032, FR-022, FR-022a)", () => {
  const batch = (over: Record<string, unknown> = {}) => ({
    v: 1,
    install: "install-1",
    session: "sess-1",
    league: { espnLeagueId: "9999999999", season: 2026 },
    messages: [],
    ...over,
  });

  it("401s a batch with NO credential, however live the draft is", async () => {
    // FR-022a: attribution is never inferred from context. A league with an
    // armed session and a draft in progress is exactly when this constraint is
    // weakest and when injected picks would do the most damage.
    const res = await app.request(
      "/api/tap/batch",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch()) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s a batch with a garbage bearer", async () => {
    const res = await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
        body: JSON.stringify(batch()),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s once the credential is revoked", async () => {
    const { token, pairing_id } = await enable();
    await app.request(`/api/tap-pairings/${pairing_id}`, { method: "DELETE", headers: { Cookie: cookie } }, env);

    const res = await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(batch()),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("ACCEPTS a batch from an enabled tap — PROVES the ingest is not simply closed", async () => {
    // Without this, every rejection above passes against an endpoint that
    // rejects everything, and the feature would look secure and relay nothing.
    const { token } = await enable();
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
      .bind("enable@test.co")
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO league_connections
         (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
       VALUES ('conn-enable', ?, '9999999999', 2026, 1, 'auto', '2026-08-01T00:00:00.000Z', 'ok')`,
    )
      .bind(account!.id)
      .run();

    const res = await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Tap-Install": "install-1",
        },
        body: JSON.stringify(batch()),
      },
      env,
    );
    expect(res.status).toBe(202);
  });
});
