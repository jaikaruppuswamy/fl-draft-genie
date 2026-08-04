// 010 T035/T036 — pairing lifecycle and per-account isolation.

import { beforeEach, describe, expect, it } from "vitest";
import { app, makeEnv, signIn } from "../helpers/app";
import { issuePairing, PAIRING_TTL_DAYS, verifyPairing } from "../../src/db/tap";
import type { Env } from "../../src/env";

const NOW = new Date("2026-08-30T23:00:00Z");
let env: Env;

beforeEach(() => {
  env = makeEnv();
});

async function seedConnection(accountId: string, leagueId = "9999999999"): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO league_connections (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, 2026, 1, 'auto', ?, 'ok')`,
  ).bind(id, accountId, leagueId, NOW.toISOString()).run();
  return id;
}

async function accountIdFor(cookie: string): Promise<string> {
  const res = await app.request("/api/leagues", { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT id FROM accounts ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
  return row!.id;
}

describe("pairing lifecycle", () => {
  // FR-011 (revocable, least-privilege credential distinct from ESPN cookies),
  // FR-013 (revocation stops the relay without touching ESPN) and FR-014a
  // (stated lifetime and install binding).
  it("issues a token once, stores only its hash, and verifies it", async () => {
    const cookie = await signIn(env, "pair@test.co");
    const res = await app.request("/api/tap-pairings", { method: "POST", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(201);
    const { token, id } = (await res.json()) as { token: string; id: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stored = await env.DB.prepare("SELECT token_hash FROM tap_pairings WHERE id = ?").bind(id).first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toBe(token);

    const v = await verifyPairing(env.DB, token, null, NOW);
    expect(v.ok).toBe(true);
  });

  it("lists pairings without ever returning the token", async () => {
    const cookie = await signIn(env, "list@test.co");
    await app.request("/api/tap-pairings", { method: "POST", headers: { Cookie: cookie } }, env);
    const body = await (await app.request("/api/tap-pairings", { headers: { Cookie: cookie } }, env)).json();
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("revokes, and a revoked token stops working immediately", async () => {
    const cookie = await signIn(env, "revoke@test.co");
    const { token, id } = (await (
      await app.request("/api/tap-pairings", { method: "POST", headers: { Cookie: cookie } }, env)
    ).json()) as { token: string; id: string };
    expect(await verifyPairing(env.DB, token, null, NOW)).toMatchObject({ ok: true });

    const del = await app.request(`/api/tap-pairings/${id}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
    expect(del.status).toBe(204);
    expect(await verifyPairing(env.DB, token, null, NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("expires on the stated schedule (FR-014a), not never", async () => {
    const cookie = await signIn(env, "expiry@test.co");
    const accountId = await accountIdFor(cookie);
    const { token } = await issuePairing(env.DB, accountId, NOW);
    const later = new Date(NOW.getTime() + (PAIRING_TTL_DAYS + 1) * 86_400_000);
    expect(await verifyPairing(env.DB, token, null, later)).toEqual({ ok: false, reason: "expired" });
  });

  it("binds to the first install and refuses a different one", async () => {
    const cookie = await signIn(env, "bind@test.co");
    const accountId = await accountIdFor(cookie);
    const connectionId = await seedConnection(accountId);
    const { token } = await issuePairing(env.DB, accountId, NOW);

    const post = (install: string) =>
      app.request(
        "/api/tap/batch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Tap-Install": install },
          body: JSON.stringify({ v: 1, install, session: "s", league: { espnLeagueId: "9999999999", season: 2026 }, connectionId, messages: [] }),
        },
        env,
      );

    expect((await post("machine-a")).status).toBe(202);
    const other = await post("machine-b");
    expect(other.status).toBe(401);
    expect((await other.json() as { error: string }).error).toBe("pairing_wrong_install");
  });

  it("rejects an unknown token", async () => {
    expect(await verifyPairing(env.DB, "f".repeat(64), null, NOW)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("isolation (FR-018)", () => {
  it("one account's token cannot relay to another account's league", async () => {
    const aCookie = await signIn(env, "owner-a@test.co");
    const aId = await accountIdFor(aCookie);
    const bCookie = await signIn(env, "owner-b@test.co");
    const bId = await accountIdFor(bCookie);
    expect(aId).not.toBe(bId);

    const bConnection = await seedConnection(bId, "8888888888");
    const { token: aToken } = await issuePairing(env.DB, aId, NOW);

    const res = await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${aToken}` },
        body: JSON.stringify({ v: 1, install: "i", session: "s", league: { espnLeagueId: "8888888888", season: 2026 }, connectionId: bConnection, messages: [] }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("pairing management requires a session", async () => {
    expect((await app.request("/api/tap-pairings", {}, env)).status).toBe(401);
    expect((await app.request("/api/tap-pairings", { method: "POST" }, env)).status).toBe(401);
  });

  it("cannot revoke another account's pairing", async () => {
    const aCookie = await signIn(env, "rev-a@test.co");
    const aId = await accountIdFor(aCookie);
    const { row } = await issuePairing(env.DB, aId, NOW);
    const bCookie = await signIn(env, "rev-b@test.co");
    const res = await app.request(`/api/tap-pairings/${row.id}`, { method: "DELETE", headers: { Cookie: bCookie } }, env);
    expect(res.status).toBe(404);
  });
});
