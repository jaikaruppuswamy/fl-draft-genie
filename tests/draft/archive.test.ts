// 005 T048/T049/T050/T058 — the completion → archive path.
//
// THIS FILE EXISTS BECAUSE ITS ABSENCE HID A REAL GAP. The oracle and the
// archive writer were built, tested and marked done — but nothing called them,
// and a full production draft left `draft_archives` empty. Module tests proved
// the parts; only a test of the WIRING proves the feature.
//
// The archive runs in the cron rather than the Durable Object because the
// oracle needs an authenticated ESPN read and FR-024a forbids the session
// holding a credential.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { archiveCompletedDrafts } from "../../src/draft/archiveRun";
import { markSessionStatus, sessionsAwaitingArchive, upsertSession } from "../../src/db/draft";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-archive";
const CONNECTION = "conn-archive";
const LEAGUE = "2222222222";
const SEASON = 2026;
const ORDER = [5, 1, 4, 6, 3, 2];

const testEnv = env as unknown as Env;

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: 1,
  order: ORDER,
  totalPicks: 6,
};

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

function pickMessage(seq: number, teamId: number, playerId: number) {
  return {
    v: 1,
    seq,
    epoch: 0,
    observedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    transport: "ws" as const,
    kind: "pick" as const,
    payload: { teamId, playerId, slot3: 0 },
  };
}

async function relayFullDraft(): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES (?, ?, ?, ?, ?, 'i', 's', ?, ?, ?, 1, 'pick', ?)`,
    )
      .bind(
        `a${i}`,
        ACCOUNT,
        CONNECTION,
        LEAGUE,
        SEASON,
        new Date(1_800_000_000_000 + i * 1000).toISOString(),
        i,
        i,
        JSON.stringify([pickMessage(i, ORDER[i - 1]!, 7000 + i)]),
      )
      .run();
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
  }
}

const NOW = new Date("2026-08-31T02:00:00.000Z");

beforeEach(async () => {
  for (const t of ["draft_picks", "draft_archives", "draft_sessions", "tap_batches"]) {
    await testEnv.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "archive@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, 1, 'auto', ?, 'ok')`,
  )
    .bind(CONNECTION, ACCOUNT, LEAGUE, SEASON, "2026-08-01T00:00:00.000Z")
    .run();
  await upsertSession(
    testEnv.DB,
    { connectionId: CONNECTION, accountId: ACCOUNT, season: SEASON, status: "armed" },
    new Date("2026-08-31T00:00:00.000Z"),
  );
  await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
    await s.storage.deleteAll();
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("the session mirrors its status to D1 (T058)", () => {
  it("writes `live` once picks start arriving", async () => {
    // Without this the row stays `armed` for the whole draft, and the armed
    // deadline becomes reachable against a session that is actually live.
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('x1', ?, ?, ?, ?, 'i', 's', '2026-08-31T01:00:00.000Z', 1, 1, 1, 'pick', ?)`,
    )
      .bind(ACCOUNT, CONNECTION, LEAGUE, SEASON, JSON.stringify([pickMessage(1, 5, 7001)]))
      .run();
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());

    const row = await testEnv.DB.prepare(`SELECT status FROM draft_sessions WHERE connection_id = ?`)
      .bind(CONNECTION)
      .first<{ status: string }>();
    expect(row!.status).toBe("live");
  });

  it("writes `complete` with a timestamp when the draft finishes", async () => {
    await relayFullDraft();
    const row = await testEnv.DB.prepare(
      `SELECT status, completed_at FROM draft_sessions WHERE connection_id = ?`,
    )
      .bind(CONNECTION)
      .first<{ status: string; completed_at: string | null }>();
    expect(row!.status).toBe("complete");
    expect(row!.completed_at).not.toBeNull();
  });

  it("never drags a completed draft back to live", async () => {
    // A late update must not reopen a finished draft.
    await relayFullDraft();
    const before = await testEnv.DB.prepare(`SELECT completed_at FROM draft_sessions WHERE connection_id = ?`)
      .bind(CONNECTION)
      .first<{ completed_at: string }>();
    await markSessionStatus(testEnv.DB, CONNECTION, "live", NOW);
    const after = await testEnv.DB.prepare(
      `SELECT status, completed_at FROM draft_sessions WHERE connection_id = ?`,
    )
      .bind(CONNECTION)
      .first<{ status: string; completed_at: string }>();
    expect(after!.status).toBe("complete");
    expect(after!.completed_at).toBe(before!.completed_at);
  });
});

describe("archiveCompletedDrafts (T048-T050)", () => {
  it("queues a completed draft and archives it", async () => {
    await relayFullDraft();
    expect(await sessionsAwaitingArchive(testEnv.DB)).toHaveLength(1);

    const outcomes = await archiveCompletedDrafts(testEnv, NOW);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.archived).toBe(true);

    const archive = await testEnv.DB.prepare(
      `SELECT id, espn_league_id, season, my_team_id FROM draft_archives`,
    ).first<{ id: string; espn_league_id: string; season: number; my_team_id: number }>();
    expect(archive).not.toBeNull();
    expect(archive!.espn_league_id).toBe(LEAGUE);
    expect(archive!.my_team_id).toBe(1);

    const picks = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM draft_picks WHERE archive_id = ?`,
    )
      .bind(archive!.id)
      .first<{ n: number }>();
    expect(picks!.n).toBe(6);
  });

  it("preserves per-pick observation times in the archive", async () => {
    // first-seen-wins. A cold rebuild or a re-archive must not flatten every
    // pick onto one instant — 008's replay lab depends on the real spacing.
    await relayFullDraft();
    await archiveCompletedDrafts(testEnv, NOW);
    const rows = await testEnv.DB.prepare(`SELECT observed_at FROM draft_picks`).all<{ observed_at: string }>();
    const times = (rows.results ?? []).map((r) => r.observed_at);
    expect(new Set(times).size).toBe(6);
  });

  it("takes a draft OUT of the queue once archived", async () => {
    await relayFullDraft();
    await archiveCompletedDrafts(testEnv, NOW);
    expect(await sessionsAwaitingArchive(testEnv.DB)).toHaveLength(0);
    // And a second run is a no-op rather than a duplicate.
    const again = await archiveCompletedDrafts(testEnv, NOW);
    expect(again).toHaveLength(0);
    const n = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM draft_archives`).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("archives WITHOUT the oracle when credentials are unavailable", async () => {
    // A missing or failing credential must not lose a completed draft. It is
    // archived unverified, and `oracle_checked_at` stays null to say so.
    await relayFullDraft();
    await archiveCompletedDrafts(testEnv, NOW);
    const row = await testEnv.DB.prepare(
      `SELECT oracle_checked_at, oracle_divergence_json FROM draft_archives`,
    ).first<{ oracle_checked_at: string | null; oracle_divergence_json: string | null }>();
    expect(row!.oracle_checked_at).toBeNull();
    expect(row!.oracle_divergence_json).toBeNull();
  });

  it("does NOT mark a draft archived when it has no picks", async () => {
    // A session reporting complete with nothing in it is a bug worth seeing
    // again, not one to bury by marking it done.
    await markSessionStatus(testEnv.DB, CONNECTION, "complete", NOW);
    const outcomes = await archiveCompletedDrafts(testEnv, NOW);
    expect(outcomes[0]!.archived).toBe(false);
    expect(outcomes[0]!.why).toBe("no_picks");
    expect(await sessionsAwaitingArchive(testEnv.DB)).toHaveLength(1); // still queued
  });

  it("leaves nothing queued when no draft has completed", async () => {
    expect(await archiveCompletedDrafts(testEnv, NOW)).toEqual([]);
  });
});

describe("the cron actually calls it (the gap that started this)", () => {
  it("archives through runScheduledMaintenance, not just when called directly", async () => {
    // THE TEST THAT WAS MISSING. Calling `archiveCompletedDrafts` directly
    // proves the function works; it does not prove anything invokes it. The
    // original defect was precisely that — module tested, never wired — and
    // removing the call from the cron passed the whole suite.
    const { runScheduledMaintenance } = await import("../../src/sync/predraft");
    await relayFullDraft();
    expect(await sessionsAwaitingArchive(testEnv.DB)).toHaveLength(1);

    await runScheduledMaintenance(testEnv, NOW);

    const n = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM draft_archives`).first<{ n: number }>();
    expect(n!.n, "the scheduled job must archive a completed draft").toBe(1);
    expect(await sessionsAwaitingArchive(testEnv.DB)).toHaveLength(0);
  });
});

describe("re-archiving the same draft", () => {
  it("never overwrites the FIRST observation time", async () => {
    // The ON CONFLICT path. Archiving once cannot exercise it, so the COALESCE
    // that protects per-pick timing went unverified — a mutation replacing it
    // with `excluded.observed_at` passed every test.
    const { writeArchive } = await import("../../src/db/draft");
    await relayFullDraft();
    await archiveCompletedDrafts(testEnv, NOW);

    const before = await testEnv.DB.prepare(
      `SELECT overall, observed_at FROM draft_picks ORDER BY overall`,
    ).all<{ overall: number; observed_at: string }>();
    const original = (before.results ?? []).map((r) => r.observed_at);
    expect(new Set(original).size).toBe(6);

    // Write the same archive again with every pick stamped identically — as a
    // careless re-archive or a cold rebuild would.
    const flattened = (before.results ?? []).map((r) => ({
      overall: r.overall,
      teamId: 1,
      playerId: 7000 + r.overall,
      slot3: 0,
      observedAt: "2026-08-31T09:99:99.000Z".replace("99:99", "59:59"),
      epoch: 0,
    }));
    await writeArchive(
      testEnv.DB,
      {
        accountId: ACCOUNT,
        connectionId: CONNECTION,
        espnLeagueId: LEAGUE,
        season: SEASON,
        leagueName: null,
        myTeamId: 1,
        teamCount: 6,
        roundCount: 1,
        order: ORDER,
        teams: [],
        state: {
          revision: 0,
          seq: 0,
          order: ORDER,
          myTeamId: 1,
          totalPicks: 6,
          confirmed: [],
          pending: [],
          picks: flattened,
          deckFired: {},
          clockFired: {},
          complete: true,
        },
        oracleDivergence: null,
        startedAt: null,
        completedAt: NOW.toISOString(),
      },
      NOW,
    );

    const after = await testEnv.DB.prepare(
      `SELECT observed_at FROM draft_picks ORDER BY overall`,
    ).all<{ observed_at: string }>();
    expect((after.results ?? []).map((r) => r.observed_at)).toEqual(original);
  });
});

describe("one failing stage must not cancel the others", () => {
  it("still archives when an EARLIER maintenance stage throws", async () => {
    // The scheduled job does several independent things. Run as a bare
    // sequence, the first throw cancels everything after it — so an ESPN
    // hiccup during the pre-draft scan would leave a finished draft
    // unarchived, indefinitely, with nothing saying so.
    //
    // Simulated by a DB proxy that fails ONLY the pre-draft scan's query and
    // behaves normally for everything else, so the failure is realistic rather
    // than global.
    const { runScheduledMaintenance } = await import("../../src/sync/predraft");
    await relayFullDraft();

    const realDb = testEnv.DB;
    const brokenDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes("league_snapshots") && sql.includes("draft_at")) {
            throw new Error("simulated ESPN/D1 failure during the pre-draft scan");
          }
          return target.prepare(sql);
        };
      },
    }) as D1Database;

    await runScheduledMaintenance({ ...testEnv, DB: brokenDb } as Env, NOW);

    const n = await realDb.prepare(`SELECT COUNT(*) AS n FROM draft_archives`).first<{ n: number }>();
    expect(n!.n, "a failing earlier stage must not prevent archiving").toBe(1);
  });
});
