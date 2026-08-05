// 005 T039/T040/T041 — arming, liveness and withholding, end to end (US3).
//
// The two cases that matter most are NEGATIVE, and both come from measurement
// rather than imagination:
//
//   * a 90-second gap between human picks is a normal round, not a dead tap;
//   * a 45-second heartbeat gap on a HIDDEN tab is a throttled timer, not a
//     dead tap — and the ratified design expects that tab to be backgrounded,
//     since the tap runs where the draft room is open and the UI runs wherever
//     the owner is looking.
//
// A rule that fires on either cries wolf during the one hour it matters.

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../helpers/app";
import { issuePairing } from "../../src/db/tap";
import { getSession } from "../../src/db/draft";
import { DraftSession, sessionIdFor } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-live";
const CONNECTION = "conn-live";
const LEAGUE = "6666666666";
const SEASON = 2026;
const INSTALL = "44444444-4444-4444-4444-444444444444";

const testEnv = env as unknown as Env;
let token: string;

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

/** POST a heartbeat exactly as tap 0.1.6 does. */
async function heartbeat(over: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(
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
        state: "watching",
        tapVersion: "0.1.6",
        heartbeat: true,
        hidden: false,
        league: { espnLeagueId: LEAGUE, season: SEASON },
        ...over,
      }),
    },
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function status(): Promise<Record<string, unknown>> {
  const cookie = await (await import("../helpers/app")).signIn(testEnv, "live@test.co");
  const res = await app.request(`/api/leagues/${CONNECTION}/draft`, { headers: { Cookie: cookie } }, testEnv);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM draft_sessions WHERE connection_id = ?`).bind(CONNECTION).run();
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "live@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, 1, 'auto', ?, 'ok')`,
  )
    .bind(CONNECTION, ACCOUNT, LEAGUE, SEASON, "2026-08-01T00:00:00.000Z")
    .run();
  token = (await issuePairing(testEnv.DB, ACCOUNT, new Date("2026-08-01T00:00:00Z"))).token;
  await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
    await s.storage.deleteAll();
    await s.storage.deleteAlarm();
  });
});

describe("a heartbeat arms the session (FR-007g)", () => {
  it("creates the session BEFORE any pick has been made", async () => {
    // The whole reason arming happens on the heartbeat rather than the first
    // pick: a missing or broken tap becomes visible while there is still time
    // to fix it.
    expect(await getSession(testEnv.DB, CONNECTION)).toBeNull();
    expect((await heartbeat()).status).toBe(204);

    const row = await getSession(testEnv.DB, CONNECTION);
    expect(row).not.toBeNull();
    expect(row!.armed_at).not.toBeNull();
    expect(row!.last_heartbeat_at).not.toBeNull();
  });

  it("is idempotent — a heartbeat every 15 s must not reset anything", async () => {
    await heartbeat();
    const first = await getSession(testEnv.DB, CONNECTION);
    await heartbeat();
    await heartbeat();
    const later = await getSession(testEnv.DB, CONNECTION);
    expect(later!.armed_at).toBe(first!.armed_at);
  });

  it("records the HIDDEN flag, which decides the lapse threshold", async () => {
    await heartbeat({ hidden: true });
    expect((await getSession(testEnv.DB, CONNECTION))!.heartbeat_hidden).toBe(1);
    await heartbeat({ hidden: false });
    expect((await getSession(testEnv.DB, CONNECTION))!.heartbeat_hidden).toBe(0);
  });

  it("records the tap's state and version", async () => {
    await heartbeat({ state: "relaying" });
    const row = await getSession(testEnv.DB, CONNECTION);
    expect(row!.tap_state).toBe("relaying");
    expect(row!.tap_version).toBe("0.1.6");
  });
});

describe("lapse detection and withholding (FR-007c/e/f)", () => {
  /** Age the recorded heartbeat, since we cannot wait 45 real seconds. */
  async function ageHeartbeat(msAgo: number, hidden = false): Promise<void> {
    const when = new Date(Date.now() - msAgo).toISOString();
    await testEnv.DB.prepare(
      `UPDATE draft_sessions SET last_heartbeat_at = ?, heartbeat_hidden = ? WHERE connection_id = ?`,
    )
      .bind(when, hidden ? 1 : 0, CONNECTION)
      .run();
  }

  it("does NOT withhold while the heartbeat is fresh", async () => {
    await heartbeat();
    const s = await status();
    expect(s.withholding).toBeNull();
    expect((s.tap as { lapsed: boolean }).lapsed).toBe(false);
  });

  it("withholds once the heartbeat lapses on a VISIBLE tab", async () => {
    await heartbeat();
    await ageHeartbeat(60_000, false);
    const s = await status();
    expect(s.withholding).toBe("not_receiving");
  });

  it("does NOT withhold at the same age on a HIDDEN tab", async () => {
    // The false alarm a single threshold would raise on essentially every
    // draft: a background tab's timers throttle to ~1/minute.
    await heartbeat({ hidden: true });
    await ageHeartbeat(60_000, true);
    const s = await status();
    expect(s.withholding).toBeNull();
  });

  it("does withhold on a hidden tab once even THAT tolerance is exceeded", async () => {
    await heartbeat({ hidden: true });
    await ageHeartbeat(200_000, true);
    expect((await status()).withholding).toBe("not_receiving");
  });

  it("WITHHOLDS on incompatible — picks are provably being missed", async () => {
    await heartbeat({ state: "incompatible", detail: "unknown message" });
    expect((await status()).withholding).toBe("incompatible");
  });

  it("withholds on version-rejected", async () => {
    await heartbeat({ state: "version-rejected" });
    expect((await status()).withholding).toBe("version_rejected");
  });

  it("does NOT withhold on buffering — the tap is working correctly", async () => {
    // Its picks are retained and will arrive. Withholding through an ordinary
    // outage is what teaches an owner to ignore the indicator entirely.
    await heartbeat({ state: "buffering" });
    expect((await status()).withholding).toBeNull();
  });

  it("does NOT withhold on draft-end-unknown", async () => {
    await heartbeat({ state: "draft-end-unknown" });
    expect((await status()).withholding).toBeNull();
  });
});

describe("session survival (T041)", () => {
  it("rebuilds after total storage loss, without evictDurableObject", async () => {
    // `evictDurableObject` does not exist on vitest 3 (see T004). The property
    // that matters is not the eviction mechanism but the REBUILD it triggers,
    // and that can be exercised deterministically.
    await heartbeat();
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('lv-1', ?, ?, ?, ?, 'i', 's', '2026-08-30T23:00:01.000Z', 1, 1, 1, 'pick', ?)`,
    )
      .bind(
        ACCOUNT,
        CONNECTION,
        LEAGUE,
        SEASON,
        JSON.stringify([
          {
            v: 1,
            seq: 1,
            epoch: 0,
            observedAt: "2026-08-30T23:00:01.000Z",
            transport: "ws",
            kind: "pick",
            payload: { teamId: 5, playerId: 777, slot3: 0 },
          },
        ]),
      )
      .run();
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
    const before = await runInDurableObject(stub(), (s: DraftSession) => s.fingerprint());

    await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
      await s.storage.deleteAll();
    });
    await heartbeat(); // re-arms, exactly as the live tap would
    await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());

    expect(await runInDurableObject(stub(), (s: DraftSession) => s.fingerprint())).toBe(before);
  });
});

describe("SC-001b's detection bound", () => {
  async function ageHeartbeat(msAgo: number, hidden = false): Promise<void> {
    await testEnv.DB.prepare(
      `UPDATE draft_sessions SET last_heartbeat_at = ?, heartbeat_hidden = ? WHERE connection_id = ?`,
    )
      .bind(new Date(Date.now() - msAgo).toISOString(), hidden ? 1 : 0, CONNECTION)
      .run();
  }

  // Margins are seconds wide, not milliseconds. An exact-boundary assertion
  // races the test's own execution: signing in and issuing the request takes
  // real time between stamping the heartbeat and the route reading the clock,
  // so ±1 ms would fail intermittently for reasons that have nothing to do
  // with the code.
  it("reports the lapse IMMEDIATELY on read — well inside SC-001b's 30 s", async () => {
    // NOTE A DEVIATION FROM THE PLAN, recorded rather than hidden: the plan
    // specified a 15-second liveness alarm to drive this state. The shipped
    // implementation evaluates liveness ON READ instead, from
    // `last_heartbeat_at` and the stored `hidden` flag.
    //
    // That satisfies SC-001b more tightly (detection is immediate for anyone
    // asking, rather than up to 15 s stale) and costs nothing: it needs no
    // extra alarm, so it does not keep the object resident. Every consumer —
    // the diagnostic page, and 006 when it arrives — asks through this route.
    await heartbeat();
    await ageHeartbeat(50_000, false); // comfortably past the 45 s visible bound
    expect((await status()).withholding).toBe("not_receiving");
  });

  it("does not report a lapse just INSIDE the bound", async () => {
    await heartbeat();
    await ageHeartbeat(40_000, false);
    expect((await status()).withholding).toBeNull();
  });

  it("applies the hidden bound at its own edge, not the visible one", async () => {
    await heartbeat({ hidden: true });
    // Past the VISIBLE bound but inside the hidden one: still healthy.
    await ageHeartbeat(140_000, true);
    expect((await status()).withholding).toBeNull();
    await ageHeartbeat(160_000, true);
    expect((await status()).withholding).toBe("not_receiving");
  });
});
