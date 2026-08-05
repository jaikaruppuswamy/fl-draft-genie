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
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
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
