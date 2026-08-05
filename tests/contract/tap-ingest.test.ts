// 010 T027 — the ingest contract, including the CORS PREFLIGHT.
//
// A test that asserts only the POST would leave the whole relay failing on
// draft day for a reason nothing covers: `src/` had no Access-Control handling
// at all before this feature.

import { beforeEach, describe, expect, it } from "vitest";
import { app, makeEnv } from "../helpers/app";
import { issuePairing, revokePairing } from "../../src/db/tap";
import type { Env } from "../../src/env";

const ORIGIN = "https://fantasy.espn.com";
const NOW = new Date("2026-08-30T23:00:00Z");

let env: Env;
let accountId: string;
let connectionId: string;
let token: string;

/** Insert an account + connection directly: this suite exercises the ingest
 *  surface, not the 001 connect flow. */
beforeEach(async () => {
  env = makeEnv();
  accountId = crypto.randomUUID();
  connectionId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
    .bind(accountId, `${accountId}@tap.test`, NOW.toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO league_connections (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, 'ok')`,
  )
    .bind(connectionId, accountId, "9999999999", 2026, 1, NOW.toISOString())
    .run();
  token = (await issuePairing(env.DB, accountId, NOW)).token;
});

const batch = (over: Record<string, unknown> = {}) => ({
  v: 1,
  install: "install-1",
  session: "session-1",
  league: { espnLeagueId: "9999999999", season: 2026 },
  connectionId,
  messages: [
    { v: 1, seq: 0, epoch: 0, observedAt: NOW.toISOString(), transport: "ws", kind: "pick", payload: { teamId: 5, playerId: 4429795, slot3: 2 } },
    { v: 1, seq: 1, epoch: 0, observedAt: NOW.toISOString(), transport: "ws", kind: "pick", payload: { teamId: 2, playerId: -16007, slot3: 7 } },
  ],
  ...over,
});

const INSTALL = "11111111-1111-1111-1111-111111111111";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request(
    "/api/tap/batch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
        // The real tap sends this on every request. It is REQUIRED: omitting it
        // used to skip the install binding entirely (see the bypass test below).
        "X-Tap-Install": INSTALL,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
  );

describe("CORS preflight", () => {
  it("answers OPTIONS from the ESPN origin", async () => {
    const res = await app.request(
      "/api/tap/batch",
      { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("OMITS the headers on an unlisted origin rather than rejecting", async () => {
    // GM_xmlhttpRequest is not browser-CORS-constrained; a 403 guard here would
    // break the real relay path.
    const res = await app.request(
      "/api/tap/batch",
      { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("POST /api/tap/batch", () => {
  it("is reachable — the tap routes are mounted before the session middleware", async () => {
    // If /api/* ran first this would be 401 unauthenticated regardless of token.
    const res = await post(batch());
    expect(res.status).toBe(202);
  });

  it("acknowledges with accepted_through", async () => {
    const body = (await (await post(batch())).json()) as { accepted_through: number };
    expect(body.accepted_through).toBe(1);
  });

  it("accepts a fully duplicate batch — duplicates are expected, not an error", async () => {
    await post(batch());
    const res = await post(batch());
    expect(res.status).toBe(202);
  });

  it("401s without a token, and after revocation", async () => {
    expect(
      (await app.request("/api/tap/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch()) }, env)).status,
    ).toBe(401);

    const { token: t2 } = await issuePairing(env.DB, accountId, NOW);
    const rows = await env.DB.prepare("SELECT id FROM tap_pairings WHERE account_id = ?").bind(accountId).all<{ id: string }>();
    for (const r of rows.results ?? []) await revokePairing(env.DB, accountId, r.id, NOW);
    const res = await post(batch(), { Authorization: `Bearer ${t2}` });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("pairing_revoked");
  });

  it("409s an unsupported contract version so the tap can prompt an update", async () => {
    const res = await post(batch({ v: 99 }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("unsupported_version");
  });

  it("403s a league the account does not own", async () => {
    const res = await post(batch({ connectionId: "someone-elses-connection" }));
    expect(res.status).toBe(403);
  });

  it("treats an EMPTY connectionId as absent, so an already-installed tap keeps working", async () => {
    // Regression: the shipped tap sends "" and a .min(1) rule rejected it,
    // 400ing every batch in production while the badge said "buffering".
    const res = await post(batch({ connectionId: "" }));
    expect(res.status).toBe(202);
  });

  it("resolves the connection from the ESPN league id when no connectionId is sent", async () => {
    // The tap runs on ESPN's page and knows the ESPN league id, not Draft
    // Genie's internal UUID. Requiring the UUID made every production batch
    // 400 — nothing ever supplied it.
    const body = batch();
    delete (body as Record<string, unknown>).connectionId;
    const res = await post(body);
    expect(res.status).toBe(202);
  });

  it("403s an ESPN league that is not connected to this account", async () => {
    const body = batch({ league: { espnLeagueId: "1234512345", season: 2026 } });
    delete (body as Record<string, unknown>).connectionId;
    const res = await post(body);
    expect(res.status).toBe(403);
    expect((await res.json() as { message: string }).message).toMatch(/not connected/i);
  });

  it("400s a malformed batch", async () => {
    expect((await post({ nope: true })).status).toBe(400);
  });

  it("accepts negative player ids (D/ST)", async () => {
    const res = await post(batch());
    expect(res.status).toBe(202);
  });
});

describe("retention (T047)", () => {
  it("keeps every accepted batch, so a live draft leaves a corpus behind", async () => {
    // The first real draft relayed perfectly and left nothing: the ingest
    // acknowledged without storing. This is the regression for that.
    await post(batch());
    const row = await env.DB.prepare(
      "SELECT message_count, first_seq, last_seq, kinds, messages_json FROM tap_batches WHERE account_id = ?",
    ).bind(accountId).first<{ message_count: number; first_seq: number; last_seq: number; kinds: string; messages_json: string }>();
    expect(row).toBeTruthy();
    expect(row!.message_count).toBe(2);
    expect(row!.first_seq).toBe(0);
    expect(row!.last_seq).toBe(1);
    expect(JSON.parse(row!.messages_json)).toHaveLength(2);
  });

  it("does not store an empty batch", async () => {
    await post(batch({ messages: [] }));
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tap_batches WHERE account_id = ?")
      .bind(accountId).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("REJECTS a payload carrying an identifier, and stores nothing", async () => {
    // FR-006a enforced at the boundary: a buggy or compromised tap must not be
    // able to write identifiers into our store.
    const dirty = batch();
    (dirty.messages as { payload: unknown }[])[0]!.payload = { teamId: 5, who: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}" };
    const res = await post(dirty);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("payload_not_clean");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tap_batches WHERE account_id = ?")
      .bind(accountId).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("REJECTS a payload carrying a URL", async () => {
    const dirty = batch();
    (dirty.messages as { payload: unknown }[])[0]!.payload = { href: "https://fantasy.espn.com/x?memberId=y" };
    expect((await post(dirty)).status).toBe(400);
  });
});

describe("GET /api/tap/health", () => {
  // FR-021: the install is verifiable without waiting for a real draft.
  it("is unauthenticated so the install can be verified without a draft", async () => {
    const res = await app.request("/api/tap/health", { headers: { Origin: ORIGIN } }, env);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});
