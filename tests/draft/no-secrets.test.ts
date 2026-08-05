// 005 T052/T053 — credentials and the ESPN rate bound (FR-024a, SC-008).
//
// Both are asserted STRUCTURALLY rather than by inspection, because both are
// the kind of property that decays silently. A credential reaches the session
// blob the day someone adds a convenient field; a request creeps onto the pick
// path the day someone needs one more piece of data mid-draft.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import { MAX_ESPN_REQUESTS_PER_MINUTE } from "../../src/draft/schedule";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-secrets";
const CONNECTION = "conn-secrets";
const LEAGUE = "4444444444";
const SEASON = 2026;

/** Shapes of the real credential pair. Neither may ever reach the session. */
const FAKE_S2 = "AEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const FAKE_SWID = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";

const testEnv = env as unknown as Env;

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

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "secrets@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
    await s.storage.deleteAll();
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("the session never holds a credential (FR-024a)", () => {
  it("stores no ESPN cookie value anywhere in its state", async () => {
    // Mirrors 001's SC-005 grep test. The session is fed by the tap and reads
    // D1; it has no reason to hold a credential, and this is what keeps that
    // true as the blob grows.
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('ns-s1', ?, ?, ?, ?, 'i', 's', '2026-08-30T23:00:01.000Z', 1, 1, 1, 'pick', ?)`,
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
            payload: { teamId: 5, playerId: 4362628, slot3: 0 },
          },
        ]),
      )
      .run();
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());

    const { dump, epoch } = await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
      const all = await s.storage.list();
      return { dump: JSON.stringify([...all.entries()]), epoch: (await s.storage.get<string>("epoch")) ?? "" };
    });

    expect(dump).not.toContain("espn_s2");
    expect(dump).not.toContain("SWID");
    expect(dump).not.toContain(FAKE_S2);
    expect(dump).not.toContain(FAKE_SWID);

    // No GUID-shaped value EXCEPT the session's own epoch, which it generates
    // locally and which identifies nobody. Member ids are stripped by the tap
    // at the source and re-screened at the ingest boundary; the session must
    // not reintroduce them, and a SWID is exactly this shape.
    const guids = dump.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g) ?? [];
    expect(epoch).not.toBe("");
    expect(guids.filter((g) => g !== epoch)).toEqual([]);
  });

  it("exposes no credential through the snapshot the client receives", async () => {
    const snap = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    const json = JSON.stringify(snap);
    expect(json).not.toContain("espn_s2");
    expect(json).not.toContain("SWID");
  });
});

describe("the ESPN rate bound (SC-008)", () => {
  it("issues ZERO ESPN requests on the pick path", async () => {
    // The strongest form of FR-008: not "few requests per minute" but none at
    // all where it matters. Picks come from the tap; Gate 0 proved no read API
    // can see a draft in progress, so a request here would be both useless and
    // a rate-bound risk.
    //
    // Asserted by exhausting the mock: any outbound fetch would throw.
    const { fetchMock } = await import("cloudflare:test");
    fetchMock.activate();
    fetchMock.disableNetConnect();

    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('ns-r1', ?, ?, ?, ?, 'i', 's', '2026-08-30T23:00:02.000Z', 2, 2, 1, 'pick', ?)`,
    )
      .bind(
        ACCOUNT,
        CONNECTION,
        LEAGUE,
        SEASON,
        JSON.stringify([
          {
            v: 1,
            seq: 2,
            epoch: 0,
            observedAt: "2026-08-30T23:00:02.000Z",
            transport: "ws",
            kind: "pick",
            payload: { teamId: 1, playerId: 111, slot3: 0 },
          },
        ]),
      )
      .run();

    // Would throw if the session reached for the network.
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
    const snap = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    expect(snap!.picks).toHaveLength(1);

    fetchMock.assertNoPendingInterceptors();
  });

  it("documents a bound the design can actually meet", async () => {
    // The old number was 25/min, sized around a 3 s poll tier that no longer
    // exists. Stating it now would document headroom nothing can use.
    const { LIVE_FLAG_POLL_MS, ARMED_POLL_MS } = await import("../../src/draft/schedule");
    expect(MAX_ESPN_REQUESTS_PER_MINUTE).toBe(5);
    // The busiest steady state is one flag poll a minute, leaving room for an
    // arm's reads to land in the same window.
    expect(60_000 / LIVE_FLAG_POLL_MS + 60_000 / ARMED_POLL_MS).toBeLessThanOrEqual(MAX_ESPN_REQUESTS_PER_MINUTE);
  });
});
