// 005 T020 (end-to-end half) — the ingest → nudge → session path (FR-007h).
//
// WHY THIS FILE EXISTS: the whole ordering invariant had no end-to-end test.
// `tests/contract/tap-ingest.test.ts` calls `app.request(path, init, env)` with
// no ExecutionContext, so `c.executionCtx` throws, the nudge is skipped by its
// own guard, and every one of those tests passes whether the nudge works or
// not. The guard is correct — a relay must never fail because an optimisation
// could not be scheduled — but it also meant the optimisation was unverified.
//
// Supplying a real ExecutionContext is what makes the path observable.

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../helpers/app";
import { issuePairing } from "../../src/db/tap";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-nudge";
const CONNECTION = "conn-nudge";
const LEAGUE = "8888888888";
const SEASON = 2026;
const INSTALL = "33333333-3333-3333-3333-333333333333";
const ORDER = [5, 2, 1, 3, 6, 4];

const testEnv = env as unknown as Env;
let token: string;

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: 1,
  order: ORDER,
  totalPicks: 72,
};

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

function batchBody(seq: number, playerId: number) {
  return {
    v: 1,
    install: INSTALL,
    session: "sess-1",
    league: { espnLeagueId: LEAGUE, season: SEASON },
    messages: [
      {
        v: 1,
        seq,
        epoch: 0,
        observedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
        transport: "ws",
        kind: "pick",
        payload: { teamId: 5, playerId, slot3: 0 },
      },
    ],
  };
}

/** POST a batch WITH an execution context, so `waitUntil` actually runs. */
async function postBatch(body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(
    "/api/tap/batch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://fantasy.espn.com",
        Authorization: `Bearer ${token}`,
        "X-Tap-Install": INSTALL,
      },
      body: JSON.stringify(body),
    },
    testEnv,
    ctx,
  );
  // Without this the nudge is still in flight when the assertion runs.
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "nudge@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, 1, 'auto', ?, 'ok')`,
  )
    .bind(CONNECTION, ACCOUNT, LEAGUE, SEASON, "2026-08-01T00:00:00.000Z")
    .run();
  token = (await issuePairing(testEnv.DB, ACCOUNT, new Date("2026-08-01T00:00:00Z"))).token;

  await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("ingest → nudge → session (FR-007h)", () => {
  it("delivers the pick to the session on the nudge, with no alarm needed", async () => {
    const res = await postBatch(batchBody(1, 4362628));
    expect(res.status).toBe(202);

    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks).toHaveLength(1);
    expect(snap!.picks[0]!.playerId).toBe(4362628);
  });

  it("acks BEFORE the session has it — the ack is a durability boundary", async () => {
    // The tap discards its buffer on `accepted_through`, so the ack must not
    // wait on the Durable Object. Asserted by reading the response body
    // without draining waitUntil: the ack is already complete.
    const ctx = createExecutionContext();
    const res = await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://fantasy.espn.com",
          Authorization: `Bearer ${token}`,
          "X-Tap-Install": INSTALL,
        },
        body: JSON.stringify(batchBody(1, 4362628)),
      },
      testEnv,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted_through: number };
    expect(body.accepted_through).toBe(1);

    // And the row is already durable at that point, so nothing is at risk.
    const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM tap_batches WHERE account_id = ?`)
      .bind(ACCOUNT)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);

    await waitOnExecutionContext(ctx);
  });

  it("keeps working across several batches, in order", async () => {
    await postBatch(batchBody(1, 100));
    await postBatch(batchBody(2, 101));
    await postBatch(batchBody(3, 102));
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks.map((p) => p.playerId)).toEqual([100, 101, 102]);
  });

  it("does not double-apply when the same batch is posted twice", async () => {
    await postBatch(batchBody(1, 100));
    await postBatch(batchBody(1, 100));
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks).toHaveLength(1);
  });
});
