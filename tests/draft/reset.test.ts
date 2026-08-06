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
