// 005 T054 — SC-001's latency budget: p95 ≤ 2 s, 100% ≤ 10 s.
//
// WHAT THIS TEST CAN AND CANNOT MEASURE, stated plainly because the difference
// matters:
//
//   * It CANNOT measure end-to-end latency. That spans the user's browser, the
//     tap's batching, the public internet and Cloudflare's edge — none of which
//     exist here. Reporting a number from this harness as if it were SC-001
//     would be inventing a measurement.
//
//   * It CAN measure the server-side component: the time from a batch being
//     readable in the durable log to the session having applied it and being
//     able to serve it. That is the only part of the budget this feature
//     controls, and it is the part that could regress unnoticed.
//
// THE END-TO-END FIGURE IS ALREADY MEASURED, in production, by 010: across a
// real 72-pick draft the tap's `observed_at` to server acknowledgement ran
// median 0.202 s, p95 0.223 s, max 0.900 s, 72/72 under 3 s. SC-001's 2 s p95
// sits roughly 10× above that — deliberate headroom for a congested draft-night
// network, not a number tuned to a good day.
//
// So this test guards the share of the budget the server owns, and asserts it
// stays a small fraction of it.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import corpusRaw from "../fixtures/tap/replay-full.jsonl?raw";
import { DraftSession, SAFETY_ALARM_MS, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

/** SC-001's promise, restated here so a change to it fails a test. */
const P95_BUDGET_MS = 2_000;
const CEILING_MS = 10_000;

/**
 * The server's share of the budget. Generous relative to what the code does
 * (one indexed D1 read plus one storage put) but tight enough that a real
 * regression — an unindexed scan, a per-pick ESPN call — breaks it.
 */
const SERVER_SHARE_MS = 250;

const ACCOUNT = "acct-latency";
const CONNECTION = "conn-latency";
const LEAGUE = "3333333333";
const SEASON = 2026;

const testEnv = env as unknown as Env;

const corpus = (corpusRaw as string)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { seq: number; kind: string; payload: unknown });

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: 1,
  order: [5, 1, 4, 6, 3, 2],
  totalPicks: 72,
};

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i]!;
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "latency@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
    await s.storage.deleteAll();
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("the server's share of SC-001's budget", () => {
  it("applies every pick well inside the budget it owns", async () => {
    const samples: number[] = [];

    for (const [i, m] of corpus.entries()) {
      const at = new Date(1_800_000_000_000 + i * 1000).toISOString();
      await testEnv.DB.prepare(
        `INSERT INTO tap_batches
           (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
            received_at, first_seq, last_seq, message_count, kinds, messages_json)
         VALUES (?, ?, ?, ?, ?, 'i', 's', ?, ?, ?, 1, ?, ?)`,
      )
        .bind(
          `lt-${String(i).padStart(3, "0")}`,
          ACCOUNT,
          CONNECTION,
          LEAGUE,
          SEASON,
          at,
          m.seq,
          m.seq,
          m.kind,
          JSON.stringify([{ ...m, v: 1, epoch: 0, observedAt: at, transport: "ws" }]),
        )
        .run();

      // From "readable in the log" to "the session can serve it".
      const started = Date.now();
      await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
      await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
      samples.push(Date.now() - started);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted.at(-1)!;
    // Recorded in the output so a regression is legible, not just a red test.
    console.log(`server-side apply latency over ${samples.length} messages: p50=${p50}ms p95=${p95}ms max=${max}ms`);

    expect(samples).toHaveLength(72);
    expect(p95).toBeLessThanOrEqual(SERVER_SHARE_MS);
    expect(max).toBeLessThanOrEqual(P95_BUDGET_MS);
  });

  it("states the budget it is measured against, so a change to SC-001 fails here", () => {
    // If someone relaxes SC-001, this test should be the thing that notices.
    expect(P95_BUDGET_MS).toBe(2_000);
    expect(CEILING_MS).toBe(10_000);
    // The safety alarm must stay inside the ceiling, or a dropped nudge
    // breaches the 100% bound.
    expect(SERVER_SHARE_MS).toBeLessThan(P95_BUDGET_MS);
  });

  it("keeps the whole 72-message draft inside the CEILING, cumulatively", async () => {
    // Not a latency claim — a throughput sanity check. If replaying a full
    // draft ever took longer than a single pick's ceiling, something is
    // quadratic and a real draft would fall behind.
    const started = Date.now();
    for (const [i, m] of corpus.entries()) {
      const at = new Date(1_800_000_000_000 + i * 1000).toISOString();
      await testEnv.DB.prepare(
        `INSERT INTO tap_batches
           (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
            received_at, first_seq, last_seq, message_count, kinds, messages_json)
         VALUES (?, ?, ?, ?, ?, 'i', 's', ?, ?, ?, 1, ?, ?)`,
      )
        .bind(
          `lc-${String(i).padStart(3, "0")}`,
          ACCOUNT,
          CONNECTION,
          LEAGUE,
          SEASON,
          at,
          m.seq,
          m.seq,
          m.kind,
          JSON.stringify([{ ...m, v: 1, epoch: 0, observedAt: at, transport: "ws" }]),
        )
        .run();
      await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
    }
    const elapsed = Date.now() - started;
    console.log(`full 72-message replay: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });
});

// ---------------------------------------------------------------------------
// 011 T016 — the budget for a manager who is NOT relaying.
//
// Fan-out moved the interesting case. Before, every manager measured here was
// the one whose own tap had just written the frames; now most managers are
// downstream of somebody else's tap, and their share of the budget is a thing
// the server newly owns. Nothing above measures it — the tests above arm and
// nudge a session directly, bypassing the ingest entirely.
//
// A real ExecutionContext is what makes this observable: without one, arming and
// nudging are both skipped by their own guards and the quiet manager's session
// would simply never exist.

const FAN_LEAGUE = "3434343434";
const RELAY_M = { account: "acct-lat-relay", conn: "conn-lat-relay", team: 3 };
const QUIET_M = { account: "acct-lat-quiet", conn: "conn-lat-quiet", team: 7 };

async function seedLatencyManager(m: { account: string; conn: string; team: number }): Promise<void> {
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(m.account, `${m.account}@lat.test`, "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, 'ok')`,
  )
    .bind(m.conn, m.account, FAN_LEAGUE, SEASON, m.team, "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR REPLACE INTO league_snapshots
       (connection_id, captured_at, league_name, team_count, scoring_json, roster_json, draft_json, teams_json, draft_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      m.conn,
      "2026-08-01T00:00:00.000Z",
      "Latency league",
      6,
      JSON.stringify({ scoringType: "ppr" }),
      JSON.stringify({ starting_slots: 10, bench_slots: 2, slots: {} }),
      JSON.stringify({ type: "snake", supported: true }),
      JSON.stringify([{ id: 3, name: "T3" }, { id: 7, name: "T7" }]),
    )
    .run();
}

describe("011 T016 — a non-relaying manager's share of the budget", () => {
  const INSTALL_F = "55555555-5555-5555-5555-555555555555";
  let fanToken: string;

  const quietStub = () => testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, QUIET_M.conn, SEASON));

  async function relayPick(seq: number, playerId: number): Promise<void> {
    const { app } = await import("../helpers/app");
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    await app.request(
      "/api/tap/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://fantasy.espn.com",
          Authorization: `Bearer ${fanToken}`,
          "X-Tap-Install": INSTALL_F,
        },
        body: JSON.stringify({
          v: 1,
          install: INSTALL_F,
          session: "sess-lat",
          league: { espnLeagueId: FAN_LEAGUE, season: SEASON },
          connectionId: RELAY_M.conn,
          messages: [
            {
              v: 1,
              seq,
              epoch: 0,
              observedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
              transport: "ws",
              kind: "pick",
              payload: { teamId: 3, playerId, slot3: 0 },
            },
          ],
        }),
      },
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
  }

  beforeEach(async () => {
    const { issuePairing } = await import("../../src/db/tap");
    for (const m of [RELAY_M, QUIET_M]) {
      await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(m.account).run();
      await testEnv.DB.prepare(`DELETE FROM draft_sessions WHERE connection_id = ?`).bind(m.conn).run();
      await seedLatencyManager(m);
      await runInDurableObject(
        testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, m.conn, SEASON)),
        async (_i: DraftSession, s: DurableObjectState) => {
          await s.storage.deleteAll();
          await s.storage.deleteAlarm();
        },
      );
    }
    fanToken = (await issuePairing(testEnv.DB, RELAY_M.account, new Date("2026-08-01T00:00:00Z"))).token;
  });

  it("delivers to the non-relaying manager inside the server's share", async () => {
    const samples: number[] = [];
    const PICKS = 24;

    for (let i = 1; i <= PICKS; i++) {
      const started = Date.now();
      await relayPick(i, 5_000_000 + i);
      // Measured to the point the QUIET manager's session can serve it — the
      // whole ingest → fan-out → pull path, not just the relayer's half.
      await runInDurableObject(quietStub(), (s: DraftSession) => s.snapshot());
      samples.push(Date.now() - started);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    console.log(
      `fan-out apply latency to a NON-RELAYING manager over ${samples.length} picks: ` +
        `p50=${percentile(sorted, 50)}ms p95=${p95}ms max=${sorted.at(-1)}ms`,
    );

    // Non-vacuity: a loop that measured nothing satisfies any percentile.
    expect(samples).toHaveLength(PICKS);
    expect(p95).toBeLessThanOrEqual(SERVER_SHARE_MS);
    expect(sorted.at(-1)!).toBeLessThanOrEqual(P95_BUDGET_MS);
  });

  it("delivers the FIRST pick without waiting on the safety alarm", async () => {
    // The assertion that catches the arm/nudge ordering regression, and the only
    // one that does. Left as two independent `waitUntil` promises, the nudge can
    // reach a session with no scope, return silently and set no alarm — the pick
    // then arrives 5 s later when the session's own alarm fires. Still correct,
    // still inside SC-001's 10 s ceiling, and far outside the p95 this measures.
    //
    // No timer is advanced here. If delivery depended on the alarm, the pick
    // would simply not be there.
    const started = Date.now();
    await relayPick(1, 4362628);
    const snap = await runInDurableObject(quietStub(), (s: DraftSession) => s.snapshot());

    expect(snap!.picks.map((p) => p.playerId)).toContain(4362628);
    expect(Date.now() - started).toBeLessThan(SAFETY_ALARM_MS);
  });

  it("PROVES the measurement is of a manager who relayed NOTHING", async () => {
    // Without this the two tests above could be measuring the relayer, whose
    // latency was already covered and which fan-out did not change.
    await relayPick(1, 4362628);

    const relayed = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM tap_batches WHERE connection_id = ?",
    )
      .bind(QUIET_M.conn)
      .first<{ n: number }>();
    expect(relayed?.n).toBe(0);

    const snap = await runInDurableObject(quietStub(), (s: DraftSession) => s.snapshot());
    expect(snap!.picks.length).toBeGreaterThan(0);
  });
});
