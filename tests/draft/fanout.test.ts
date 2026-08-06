// 011 T007/T010 — one manager relays, EVERY manager in the league sees it.
//
// The MVP of this feature, and the thing that decides whether Draft Genie works
// for anyone who cannot run a userscript — which is most managers, and everyone
// on an iPad.
//
// A real ExecutionContext is mandatory here. `app.request(path, init, env)` with
// no context makes `c.executionCtx` throw, so the arm and the nudge are both
// skipped by their own guards and every assertion below would pass against an
// implementation that fans out to nobody. `tests/draft/ingest-nudge.test.ts`
// exists for the same reason and is the model for this file.
//
// The trap this file is built around: arming and nudging everyone is the
// VISIBLE half of fan-out, and it delivers nothing on its own, because the
// session pulls its frames from a log that was account-scoped until Phase 3.
// Case 2 is the one that fails if only the visible half is built.

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../helpers/app";
import { issuePairing } from "../../src/db/tap";
import { listConnectionsForLeague } from "../../src/db/leagues";
import { DraftSession, sessionIdFor } from "../../src/draft/session";
import type { Env } from "../../src/env";

const LEAGUE = "6161616161";
const OTHER_LEAGUE = "6262626262";
const SEASON = 2026;
const INSTALL = "44444444-4444-4444-4444-444444444444";

// Two managers in ONE league. `league_connections` is UNIQUE on
// (account_id, espn_league_id, season), so two managers are two accounts.
const RELAYER = { account: "acct-fan-relayer", conn: "conn-fan-relayer", team: 3 };
const QUIET = { account: "acct-fan-quiet", conn: "conn-fan-quiet", team: 7 };
// A manager in a DIFFERENT league. Must never be armed by this league's frames.
const OUTSIDER = { account: "acct-fan-outsider", conn: "conn-fan-outsider", team: 1 };

const testEnv = env as unknown as Env;
let token: string;

const stub = (connectionId: string) =>
  testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, connectionId, SEASON));

const snapshotOf = (connectionId: string) =>
  runInDurableObject(stub(connectionId), (s: DraftSession) => s.snapshot());

function batchBody(seq: number, playerId: number, teamId = 3) {
  return {
    v: 1,
    install: INSTALL,
    session: "sess-fan",
    league: { espnLeagueId: LEAGUE, season: SEASON },
    connectionId: RELAYER.conn,
    messages: [
      {
        v: 1,
        seq,
        epoch: 0,
        observedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
        transport: "ws" as const,
        kind: "pick" as const,
        payload: { teamId, playerId, slot3: 0 },
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
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedManager(
  m: { account: string; conn: string; team: number },
  league: string,
  rounds: number,
): Promise<void> {
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(m.account, `${m.account}@fan.test`, "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, 'ok')`,
  )
    .bind(m.conn, m.account, league, SEASON, m.team, "2026-08-01T00:00:00.000Z")
    .run();
  // Each manager gets their OWN snapshot, with a DIFFERENT round count. Two
  // managers in one league really did record 11 and 12 rounds for the same
  // draft on 2026-08-06 — one snapshot was stale. Reusing the relayer's
  // snapshot to save N reads is the shortcut this fixture exists to catch.
  await testEnv.DB.prepare(
    `INSERT OR REPLACE INTO league_snapshots
       (connection_id, captured_at, league_name, team_count, scoring_json, roster_json, draft_json, teams_json, draft_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      m.conn,
      "2026-08-01T00:00:00.000Z",
      "Fan-out league",
      2,
      JSON.stringify({ scoringType: "ppr" }),
      // `totalPicksFrom` = teamCount * (starting_slots + bench_slots), so the
      // round count is what makes two managers disagree.
      JSON.stringify({ starting_slots: rounds - 2, bench_slots: 2, slots: {} }),
      JSON.stringify({ type: "snake", supported: true }),
      JSON.stringify([
        { id: 3, name: "T3" },
        { id: 7, name: "T7" },
      ]),
    )
    .run();
}

beforeEach(async () => {
  for (const m of [RELAYER, QUIET, OUTSIDER]) {
    await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(m.account).run();
  }
  await seedManager(RELAYER, LEAGUE, 11);
  await seedManager(QUIET, LEAGUE, 12);
  await seedManager(OUTSIDER, OTHER_LEAGUE, 12);
  token = (await issuePairing(testEnv.DB, RELAYER.account, new Date("2026-08-01T00:00:00Z"))).token;

  for (const m of [RELAYER, QUIET, OUTSIDER]) {
    await runInDurableObject(stub(m.conn), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
  }
});

describe("the audience is the LEAGUE (FR-001, FR-004)", () => {
  it("has an audience to fan out to", async () => {
    // Without this every assertion below passes against a fixture where
    // nothing was inserted — 006's mutation sweep found 10 of 102 tests
    // running for exactly that reason.
    const audience = await listConnectionsForLeague(testEnv.DB, LEAGUE, SEASON);
    expect(audience.map((c) => c.id).sort()).toEqual([QUIET.conn, RELAYER.conn].sort());
  });

  it("arms a manager who has no tap of their own", async () => {
    // Today a session arms from its OWN tap's first frame, so a manager without
    // one has no session at all — not an empty draft, nothing to attach to.
    expect(await postBatch(batchBody(1, 4362628))).toHaveProperty("status", 202);
    expect(await snapshotOf(QUIET.conn)).not.toBeNull();
  });

  it("DELIVERS the pick to that manager — the half that arming alone does not do", async () => {
    // THE test for this feature. Arming everyone is visible and satisfying and
    // delivers nothing by itself: the session pulls from a log that was
    // account-scoped, and these frames carry the relayer's account.
    await postBatch(batchBody(1, 4362628));

    const snap = await snapshotOf(QUIET.conn);
    expect(snap!.picks.map((p) => p.playerId)).toContain(4362628);
  });

  it("never arms a manager in a DIFFERENT league", async () => {
    await postBatch(batchBody(1, 4362628));
    expect(await snapshotOf(OUTSIDER.conn)).toBeNull();
  });
});

describe("every manager keeps their OWN perspective (FR-002, FR-005, SC-002)", () => {
  it("gives each session its own team, never the relayer's", async () => {
    await postBatch(batchBody(1, 4362628));

    const mine = await runInDurableObject(stub(QUIET.conn), (_i: DraftSession, state: DurableObjectState) =>
      state.storage.get<{ myTeamId: number }>("scope"),
    );
    expect(mine?.myTeamId).toBe(QUIET.team);
    expect(mine?.myTeamId).not.toBe(RELAYER.team);
  });

  it("gives each session its own totalPicks, so one stale sync cannot reshape another's board", async () => {
    // 11 rounds vs 12, from each manager's own snapshot. The shortcut that
    // breaks this — reuse the relayer's snapshot for everyone — is invisible
    // until two managers disagree, and then it is silent.
    await postBatch(batchBody(1, 4362628));

    const relayer = await snapshotOf(RELAYER.conn);
    const quiet = await snapshotOf(QUIET.conn);
    expect(relayer!.totalPicks).not.toBe(quiet!.totalPicks);
  });
});

describe("no relayer identity reaches a delivered view (FR-003, SC-003)", () => {
  it("names nothing about the relayer in the receiving manager's session", async () => {
    await postBatch(batchBody(1, 4362628));

    const snap = await snapshotOf(QUIET.conn);
    const scope = await runInDurableObject(stub(QUIET.conn), (_i: DraftSession, state: DurableObjectState) =>
      state.storage.get<Record<string, unknown>>("scope"),
    );
    const delivered = JSON.stringify({ snap, scope });

    for (const secret of [RELAYER.account, RELAYER.conn, INSTALL, "sess-fan"]) {
      expect(delivered, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("PROVES the check can fail — the same matcher trips on a payload that DOES carry it", async () => {
    // Without this, the assertion above passes against an empty payload.
    await postBatch(batchBody(1, 4362628));
    const snap = await snapshotOf(QUIET.conn);
    const delivered = JSON.stringify(snap);

    // Something known to be present, so we know we are looking at real content.
    expect(delivered).toContain("4362628");
    // And the matcher genuinely fires when the identity IS there.
    expect(JSON.stringify({ ...snap, relayedBy: RELAYER.conn })).toContain(RELAYER.conn);
  });
});

describe("one manager's problem is not everyone's (FR-004)", () => {
  it("still arms the others when one manager's league data is unusable", async () => {
    // An early `return` on the first unsupported manager unarms the whole
    // league, silently, for a reason that has nothing to do with them.
    await testEnv.DB.prepare(`UPDATE league_snapshots SET draft_json = ? WHERE connection_id = ?`)
      .bind(JSON.stringify({ type: "auction", supported: false }), QUIET.conn)
      .run();

    expect(await postBatch(batchBody(1, 4362628))).toHaveProperty("status", 202);
    expect(await snapshotOf(RELAYER.conn)).not.toBeNull();
  });

  it("still acks the tap, so the fan-out never sits on the relay's request path", async () => {
    // The tap discards its buffer only on `accepted_through`. A fan-out that
    // can fail the POST costs the whole league its frames AND stalls the
    // relayer's buffer.
    const res = await postBatch(batchBody(1, 4362628));
    expect(res.status).toBe(202);
    expect(await res.json()).toHaveProperty("accepted_through", 1);
  });
});

describe("several relays converge (FR-007a, FR-007b — T014, T015)", () => {
  it("folds the SAME pick relayed by two managers into one", async () => {
    // Cross-account duplication has never been tested: every existing fixture
    // has one relaying account. Dedup keys on player identity and nothing keys
    // on install or tap session, so this should already hold — the test is what
    // makes that a guarantee rather than a coincidence.
    const second = (await issuePairing(testEnv.DB, QUIET.account, new Date("2026-08-01T00:00:00Z"))).token;
    await postBatch(batchBody(1, 4362628));

    const ctx = createExecutionContext();
    await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://fantasy.espn.com",
          Authorization: `Bearer ${second}`,
          "X-Tap-Install": INSTALL,
        },
        body: JSON.stringify({
          ...batchBody(1, 4362628),
          connectionId: QUIET.conn,
          session: "sess-fan-2",
        }),
      },
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const snap = await snapshotOf(QUIET.conn);
    expect(snap!.picks.filter((p) => p.playerId === 4362628)).toHaveLength(1);
  });
});
