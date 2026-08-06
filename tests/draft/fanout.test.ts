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

describe("a manager JOINING does not inherit the league's history", () => {
  it("starts at the log's tip, not at a mock draft from last week", async () => {
    // The league-wide log is never pruned, so a session starting at
    // `cursor: null` reads the OLDEST rows in the league. US1's persona is
    // exactly the manager who arrives cold, and without a floor their first
    // sight of Draft Genie is a board full of a draft that already finished —
    // the 2026-08-06 failure, reached from a different direction.
    //
    // Relay a "previous draft" BEFORE the quiet manager has any session.
    await postBatch(batchBody(1, 111111));
    await postBatch(batchBody(2, 222222));

    // Now wipe the quiet manager's session and its D1 row, so the next frame
    // arms them as genuinely new — the joining case.
    await runInDurableObject(stub(QUIET.conn), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
    await testEnv.DB.prepare(`DELETE FROM draft_sessions WHERE connection_id = ?`).bind(QUIET.conn).run();

    await postBatch(batchBody(3, 333333));

    const snap = await snapshotOf(QUIET.conn);
    const ids = snap!.picks.map((p) => p.playerId);
    expect(ids).toContain(333333);
    expect(ids).not.toContain(111111);
    expect(ids).not.toContain(222222);
  });

  it("PROVES the floor is conditional — a session that has run before still re-reads the log", async () => {
    // Without this, "does not inherit history" passes against an implementation
    // that floors every arm, which would silently destroy recovery from storage
    // loss: after an eviction the object is empty and the log is what brings the
    // draft back. The D1 row is what tells the two apart, so it stays.
    await postBatch(batchBody(1, 111111));
    await postBatch(batchBody(2, 222222));

    await runInDurableObject(stub(QUIET.conn), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
    // draft_sessions row deliberately LEFT in place: this session has run before.

    await postBatch(batchBody(3, 333333));

    const ids = (await snapshotOf(QUIET.conn))!.picks.map((p) => p.playerId);
    expect(ids).toContain(111111);
    expect(ids).toContain(222222);
  });
});

describe("the room asks whether ANYONE is relaying (011 T012, FR-006)", () => {
  // The bug fan-out creates. A manager who runs no tap still has an armed
  // session, but `recordHeartbeat` only ever touches the RELAYER's row, so
  // theirs keeps `last_heartbeat_at = NULL`. `heartbeatLapsed` reads a null
  // heartbeat as "not lapsed" — correctly, there is nothing to be stale about —
  // so asking the viewer's own row reported a healthy relay to a manager in a
  // league where nobody was relaying at all.
  //
  // The room would say "Live" with no feed behind it. In the feature about
  // telling the truth, that is the worst available answer.

  async function draftStatus(m: { account: string; conn: string }): Promise<Record<string, unknown>> {
    const { signIn } = await import("../helpers/app");
    const cookie = await signIn(testEnv, `${m.account}@fan.test`);
    const res = await app.request(`/api/leagues/${m.conn}/draft`, { headers: { Cookie: cookie } }, testEnv);
    return (await res.json()) as Record<string, unknown>;
  }

  it("reports NO active relay to a manager whose league has none", async () => {
    // Armed by fan-out, but nobody has heartbeated anywhere in the league.
    await postBatch(batchBody(1, 4362628));

    const body = await draftStatus(QUIET);
    expect(body.armed).toBe(true);
    expect((body.relay as { active: boolean }).active).toBe(false);
  });

  it("reports an ACTIVE relay when a LEAGUEMATE is heartbeating", async () => {
    // The other direction, and it is not optional: a rule that only ever says
    // "absent" is exactly as wrong as one that never does, and both pass a
    // one-sided test.
    await postBatch(batchBody(1, 4362628));
    const ctx = createExecutionContext();
    await app.request(
      "/api/tap/status",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://fantasy.espn.com",
          Authorization: `Bearer ${token}`,
          "X-Tap-Install": INSTALL,
        },
        body: JSON.stringify({
          state: "relaying",
          heartbeat: true,
          hidden: false,
          league: { espnLeagueId: LEAGUE, season: SEASON },
        }),
      },
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // The RELAYER heartbeated; the QUIET manager is the one asking.
    const body = await draftStatus(QUIET);
    expect((body.relay as { active: boolean }).active).toBe(true);
    expect((body.relay as { lastRelayedAt: string | null }).lastRelayedAt).toBeTruthy();
  });

  it("never names WHO is relaying, or what their tab is doing (FR-003)", async () => {
    // "Someone is relaying" is a shared fact about the league. Which manager,
    // and whether their browser tab is backgrounded, are facts about them.
    await postBatch(batchBody(1, 4362628));
    const body = await draftStatus(QUIET);

    const relay = JSON.stringify(body.relay);
    expect(relay).not.toContain(RELAYER.conn);
    expect(relay).not.toContain(RELAYER.account);
    expect(Object.keys(body.relay as object).sort()).toEqual(["active", "lastRelayedAt"]);
  });
});

describe("a settings disagreement is SURFACED, not resolved (011 T011, FR-005)", () => {
  // The fixture gives these two managers 11 and 12 rounds for the same draft —
  // the real 2026-08-06 shape, where one manager's snapshot was stale.
  //
  // Resolving it is the tempting move and the wrong one: nothing distinguishes
  // the stale sync from the fresh one, so picking a winner silently reshapes
  // somebody's board. Each session keeps its own number; the league is told the
  // numbers disagree.

  it("reports the disagreement to BOTH managers, with the same values", async () => {
    await postBatch(batchBody(1, 4362628));

    const quiet = await snapshotOf(QUIET.conn);
    const relayer = await snapshotOf(RELAYER.conn);

    expect(quiet!.disagreement).not.toBeNull();
    expect(quiet!.disagreement!.totals).toEqual(relayer!.disagreement!.totals);
    expect(quiet!.disagreement!.totals.length).toBeGreaterThan(1);
  });

  it("does NOT resolve it — each session still uses its own count", async () => {
    // The half that was already true, asserted here so a later "tidy-up" that
    // makes everyone agree fails loudly instead of quietly.
    await postBatch(batchBody(1, 4362628));

    const quiet = await snapshotOf(QUIET.conn);
    const relayer = await snapshotOf(RELAYER.conn);
    expect(quiet!.totalPicks).not.toBe(relayer!.totalPicks);
    expect(quiet!.disagreement!.totals).toContain(quiet!.totalPicks);
    expect(quiet!.disagreement!.totals).toContain(relayer!.totalPicks);
  });

  it("names no manager (FR-003)", async () => {
    // Counts and values only. Which leaguemate disagrees is not the reader's
    // business, and naming them puts one manager's configuration into another's
    // view — the thing this whole feature exists to prevent.
    await postBatch(batchBody(1, 4362628));

    const d = JSON.stringify((await snapshotOf(QUIET.conn))!.disagreement);
    for (const secret of [RELAYER.conn, RELAYER.account, QUIET.conn, QUIET.account]) {
      expect(d, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("reports NOTHING when the league agrees — PROVES the check is conditional", async () => {
    // Without this, "reports the disagreement" passes against an implementation
    // that always reports one, which would put a permanent warning on a league
    // where nothing is wrong.
    await testEnv.DB.prepare(`UPDATE league_snapshots SET roster_json = ? WHERE connection_id = ?`)
      .bind(JSON.stringify({ starting_slots: 10, bench_slots: 2, slots: {} }), QUIET.conn)
      .run();
    await testEnv.DB.prepare(`UPDATE league_snapshots SET roster_json = ? WHERE connection_id = ?`)
      .bind(JSON.stringify({ starting_slots: 10, bench_slots: 2, slots: {} }), RELAYER.conn)
      .run();

    await postBatch(batchBody(1, 4362628));

    expect((await snapshotOf(QUIET.conn))!.disagreement).toBeNull();
  });

  it("treats an UNKNOWN length as unknown, not as a disagreement", async () => {
    // `totalPicks === 0` means not yet established. Counting it would report a
    // disagreement between a manager who knows and one who has not synced — the
    // same mistake 006 made reading an unknown as a claim.
    await testEnv.DB.prepare(`UPDATE league_snapshots SET roster_json = ? WHERE connection_id = ?`)
      .bind(JSON.stringify({ starting_slots: 10, bench_slots: 2, slots: {} }), RELAYER.conn)
      .run();
    await testEnv.DB.prepare(`UPDATE league_snapshots SET roster_json = ? WHERE connection_id = ?`)
      .bind(JSON.stringify({ slots: {} }), QUIET.conn)
      .run();

    await postBatch(batchBody(1, 4362628));

    expect((await snapshotOf(RELAYER.conn))!.disagreement).toBeNull();
  });
});
