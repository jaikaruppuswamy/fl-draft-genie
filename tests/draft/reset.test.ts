// 011 T040/T041 — resetting a session, and the latch that made it necessary.
//
// Before this, the only way to run a second mock draft was to disconnect the
// league and reconnect it — which mints a new connection id and destroyed a
// preferred player on 2026-08-06. The reason there was no alternative: the
// Durable Object's only clearing method, `shutdown()`, sets `closed`, and
// `arm()` returns early on `closed`. Permanent, not reset.
//
// The second defect here was found live the same evening and is subtler: a
// session can hold `completed_at` while its status says `armed`, because arming
// writes status directly and bypasses the completion latch. Both status
// transitions are guarded `WHERE completed_at IS NULL`, so such a session can
// NEVER report `live`. It will accept frames and never say the draft is running.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getSession, markSessionStatus, upsertSession } from "../../src/db/draft";
import { isLiveDraft } from "../../src/draft/liveness";
import type { Env } from "../../src/env";

const testEnv = env as unknown as Env;
const CONNECTION = "conn-reset";
const ACCOUNT = "acct-reset";
const SEASON = 2026;
const NOW = new Date("2026-08-06T05:00:00.000Z");

async function seedRows(connectionId: string, leagueId = "5550001"): Promise<void> {
  await testEnv.DB.prepare("INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
    .bind(ACCOUNT, "reset@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, 1, 'auto', ?, 'ok')`,
  )
    .bind(connectionId, ACCOUNT, leagueId, SEASON, "2026-08-01T00:00:00.000Z")
    .run();
}

async function seedComplete(): Promise<void> {
  await testEnv.DB.prepare("DELETE FROM draft_sessions WHERE connection_id = ?").bind(CONNECTION).run();
  await seedRows(CONNECTION);
  await upsertSession(
    testEnv.DB,
    { connectionId: CONNECTION, accountId: ACCOUNT, season: SEASON, status: "armed" },
    NOW,
  );
  await markSessionStatus(testEnv.DB, CONNECTION, "complete", NOW);
}

describe("the completion latch", () => {
  beforeEach(seedComplete);

  it("records completion once", async () => {
    const row = await getSession(testEnv.DB, CONNECTION);
    expect(row?.status).toBe("complete");
    expect(row?.completed_at).toBeTruthy();
  });

  it("does NOT let arming produce `armed` while a completion stamp is held", async () => {
    // The live 2026-08-06 state: status `armed`, `completed_at` set. Such a
    // session can never transition to `live`, because that transition requires
    // `completed_at IS NULL` — so it accepts frames and never reports a running
    // draft. Arming must leave a completed session complete; the only ways out
    // are an explicit reset (US5) or an observed ESPN reset (US8).
    await upsertSession(
      testEnv.DB,
      { connectionId: CONNECTION, accountId: ACCOUNT, season: SEASON, status: "armed" },
      NOW,
    );
    const row = await getSession(testEnv.DB, CONNECTION);

    const split = row?.status !== "complete" && row?.completed_at !== null;
    expect(split, "session is armed while holding a completion stamp").toBe(false);
  });

  it("still arms normally when there is no completion stamp", async () => {
    // The guard must not freeze an ordinary session. This is the case that
    // would break if arming simply stopped writing status.
    await testEnv.DB.prepare("DELETE FROM draft_sessions WHERE connection_id = ?").bind(CONNECTION).run();
    await upsertSession(
      testEnv.DB,
      { connectionId: CONNECTION, accountId: ACCOUNT, season: SEASON, status: "idle" },
      NOW,
    );
    await upsertSession(
      testEnv.DB,
      { connectionId: CONNECTION, accountId: ACCOUNT, season: SEASON, status: "armed" },
      NOW,
    );
    expect((await getSession(testEnv.DB, CONNECTION))?.status).toBe("armed");
  });
});

describe("resetting clears the stamp and the status TOGETHER (FR-044)", () => {
  beforeEach(seedComplete);

  it("releases the latch so the session can run another draft", async () => {
    const { resetSession } = await import("../../src/db/draft");
    await resetSession(testEnv.DB, CONNECTION, NOW);

    const row = await getSession(testEnv.DB, CONNECTION);
    expect(row?.completed_at).toBeNull();
    expect(row?.status).not.toBe("complete");
  });

  it("leaves the session able to reach `live` again", async () => {
    // The whole point. `markSessionStatus(..., "live")` requires
    // `completed_at IS NULL` — if reset clears status but not the stamp, the
    // session looks fine and can never report a running draft.
    const { resetSession } = await import("../../src/db/draft");
    await resetSession(testEnv.DB, CONNECTION, NOW);
    await markSessionStatus(testEnv.DB, CONNECTION, "live", NOW);

    expect((await getSession(testEnv.DB, CONNECTION))?.status).toBe("live");
  });

  it("PROVES the check can fail — clearing only the status is not enough", async () => {
    // Without this, "reset works" passes against an implementation that clears
    // status alone and leaves the session permanently unable to go live.
    await testEnv.DB.prepare("UPDATE draft_sessions SET status = 'idle' WHERE connection_id = ?")
      .bind(CONNECTION)
      .run();
    await markSessionStatus(testEnv.DB, CONNECTION, "live", NOW);

    expect((await getSession(testEnv.DB, CONNECTION))?.status).toBe("idle");
  });

  it("does not touch another connection's session", async () => {
    const OTHER = "conn-reset-other";
    // A DIFFERENT league — one account cannot connect the same league twice.
    await seedRows(OTHER, "5550002");
    await upsertSession(
      testEnv.DB,
      { connectionId: OTHER, accountId: ACCOUNT, season: SEASON, status: "armed" },
      NOW,
    );
    const { resetSession } = await import("../../src/db/draft");
    await resetSession(testEnv.DB, CONNECTION, NOW);

    expect((await getSession(testEnv.DB, OTHER))?.status).toBe("armed");
  });
});

describe("the shared live-draft guard (FR-031d1, FR-031d2)", () => {
  // ONE guard, two callers: the owner asking to reset (FR-030) and a sync
  // observing an ESPN reset (FR-031d). Two copies would diverge, and the one
  // that diverges is the one that fires at the wrong moment.
  const NOW_MS = NOW.getTime();
  const live = (over: Partial<Parameters<typeof isLiveDraft>[0]> = {}) => ({
    status: "live",
    completedAt: null,
    lastHeartbeatAt: NOW_MS - 5_000,
    hidden: false,
    now: NOW_MS,
    ...over,
  });

  it("does NOT use pick recency — a 90 s deliberation is still a live draft", () => {
    // THE trap this task exists to avoid. 005 measured inter-pick gaps from ~1 s
    // under autodraft to 90 s+ between human picks, and concluded liveness comes
    // from the heartbeat. A recency test would void a live draft while someone
    // stares at their board — turning the guard into the thing it prevents.
    // The heartbeat is 15 s, so it is fresh throughout that gap.
    expect(isLiveDraft(live({ lastHeartbeatAt: NOW_MS - 12_000 }))).toBe(true);
  });

  it("tolerates a BACKGROUNDED tab's throttled heartbeat", () => {
    // Two minutes of silence from a hidden tab is normal, not death. The room
    // is expected to be in a background tab for the whole draft.
    expect(isLiveDraft(live({ lastHeartbeatAt: NOW_MS - 120_000, hidden: true }))).toBe(true);
    expect(isLiveDraft(live({ lastHeartbeatAt: NOW_MS - 120_000, hidden: false }))).toBe(false);
  });

  it("a completed draft is not live — which is what makes reset possible at all", () => {
    expect(isLiveDraft(live({ completedAt: "2026-08-06T04:00:00.000Z" }))).toBe(false);
  });

  it("a session that never heard from a tap is not live", () => {
    // `heartbeatLapsed` returns false for a null heartbeat because there is
    // nothing to be stale about. Read as "not lapsed ⇒ live", that would make
    // every never-armed session permanently unresettable.
    expect(isLiveDraft(live({ lastHeartbeatAt: null }))).toBe(false);
  });

  it("an idle or aborted session is not live", () => {
    expect(isLiveDraft(live({ status: "idle" }))).toBe(false);
    expect(isLiveDraft(live({ status: "complete" }))).toBe(false);
  });

  it("PROVES the guard can say yes AND no", () => {
    // Without this, every assertion above passes against `() => false`.
    expect(isLiveDraft(live())).toBe(true);
    expect(isLiveDraft(live({ lastHeartbeatAt: NOW_MS - 600_000 }))).toBe(false);
  });
});

describe("reset keeps everything that is not the draft (FR-028, FR-029, SC-009)", () => {
  // The workaround this replaces — disconnect and reconnect — destroyed a
  // preferred player on 2026-08-06. These assertions are the difference between
  // the fix and the thing it replaces.
  beforeEach(seedComplete);

  it("preserves the preferred list", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO preferred_players (connection_id, account_id, season, espn_player_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(CONNECTION, ACCOUNT, SEASON, 4262921, "2026-08-01T00:00:00.000Z")
      .run();

    const { resetSession } = await import("../../src/db/draft");
    await resetSession(testEnv.DB, CONNECTION, NOW);

    const after = await testEnv.DB.prepare(
      "SELECT espn_player_id FROM preferred_players WHERE connection_id = ?",
    )
      .bind(CONNECTION)
      .all<{ espn_player_id: number }>();
    expect(after.results.map((r) => r.espn_player_id)).toEqual([4262921]);
  });

  it("preserves the league connection itself — no new connection id", async () => {
    // The disconnect-and-reconnect workaround minted a new one, which is what
    // orphaned everything hanging off it.
    const { resetSession } = await import("../../src/db/draft");
    await resetSession(testEnv.DB, CONNECTION, NOW);

    const row = await testEnv.DB.prepare("SELECT id, my_team_id FROM league_connections WHERE id = ?")
      .bind(CONNECTION)
      .first<{ id: string; my_team_id: number }>();
    expect(row?.id).toBe(CONNECTION);
    expect(row?.my_team_id).toBe(1);
  });

  it("preserves captured frames — capture history is never destroyed (FR-029)", async () => {
    // A reset is about the derived board, not the record of what was received.
    // 008's corpus is built from these; losing them on reset would quietly
    // delete the evidence for every replay entry.
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'PICK', '[]')`,
    )
      .bind(
        "batch-keep", ACCOUNT, CONNECTION, "5550001", SEASON, "install-1", "sess-1",
        "2026-08-06T04:00:00.000Z",
      )
      .run();

    const { resetSession } = await import("../../src/db/draft");
    await resetSession(testEnv.DB, CONNECTION, NOW);

    const kept = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM tap_batches WHERE connection_id = ?",
    )
      .bind(CONNECTION)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });
});
