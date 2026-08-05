// 005 T020 — the feed's ordering guarantees (FR-007h).
//
// Three properties, each of which a plausible implementation loses:
//
//  1. The ack follows the durable write. The tap discards its buffer on the
//     ack, so acking first loses picks it has already forgotten.
//  2. The ack does not wait on the session. A restarting Durable Object must
//     not stall the tap's buffer.
//  3. A DROPPED NUDGE COSTS LATENCY, NOT DATA. This is the one worth testing
//     hardest, because the happy path hides it completely: the nudge normally
//     succeeds, so a design that depended on it would look perfect until the
//     day it didn't.

import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-order";
const CONNECTION = "conn-order";
const LEAGUE = "9999999999";
const SEASON = 2026;
const ORDER = [5, 2, 1, 3, 6, 4];

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: 1,
  order: ORDER,
  totalPicks: 72,
};

const testEnv = env as unknown as Env;

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

/** Write straight to the log, exactly as the ingest does before it acks. */
async function writeBatch(id: string, receivedAt: string, messages: unknown[]): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO tap_batches
       (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
        received_at, first_seq, last_seq, message_count, kinds, messages_json)
     VALUES (?, ?, ?, ?, ?, 'install-1', 'session-1', ?, 0, 0, ?, 'pick', ?)`,
  )
    .bind(id, ACCOUNT, CONNECTION, LEAGUE, SEASON, receivedAt, messages.length, JSON.stringify(messages))
    .run();
}

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "order@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  // Reset the object between tests: this project runs with isolatedStorage
  // off, because WebSockets in DOs are unsupported with per-file isolation.
  await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

describe("the session pulls from the log", () => {
  it("applies a batch that was written before the nudge", async () => {
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    await writeBatch("b1", "2026-08-30T23:00:01.000Z", [pickMessage(1, 5, 100)]);

    await runInDurableObject(stub(), (i: DraftSession) => i.nudge());

    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks).toHaveLength(1);
    expect(snap!.picks[0]).toMatchObject({ overall: 1, teamId: 5, playerId: 100 });
  });

  it("LOSES NOTHING when the nudge never arrives — the alarm collects it", async () => {
    // The property the whole design rests on. Write the batch and deliberately
    // do NOT nudge; the safety alarm must still deliver the pick, because the
    // log is the source of truth and the nudge is only a latency optimisation.
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    await writeBatch("b1", "2026-08-30T23:00:01.000Z", [pickMessage(1, 5, 100)]);

    const before = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(before!.picks).toHaveLength(0); // no nudge yet

    const ran = await runDurableObjectAlarm(stub());
    expect(ran).toBe(true);

    const after = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(after!.picks).toHaveLength(1);
  });

  it("is idempotent across repeated nudges — a re-read produces no duplicates", async () => {
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    await writeBatch("b1", "2026-08-30T23:00:01.000Z", [pickMessage(1, 5, 100)]);
    for (let n = 0; n < 3; n++) await runInDurableObject(stub(), (i: DraftSession) => i.nudge());

    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks).toHaveLength(1);
  });

  it("advances the cursor so a second nudge does not re-apply the same rows", async () => {
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    await writeBatch("b1", "2026-08-30T23:00:01.000Z", [pickMessage(1, 5, 100)]);
    await runInDurableObject(stub(), (i: DraftSession) => i.nudge());

    await writeBatch("b2", "2026-08-30T23:00:02.000Z", [pickMessage(2, 2, 101)]);
    await runInDurableObject(stub(), (i: DraftSession) => i.nudge());

    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks.map((p) => p.playerId)).toEqual([100, 101]);
  });

  it("does nothing at all before the session is armed", async () => {
    // An unarmed session has no scope, so it cannot know whose log to read.
    // It must stay silent rather than guess.
    await writeBatch("b1", "2026-08-30T23:00:01.000Z", [pickMessage(1, 5, 100)]);
    await runInDurableObject(stub(), (i: DraftSession) => i.nudge());
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap).toBeNull();
  });

  it("keeps the alarm armed while the draft is live", async () => {
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    const alarm = await runInDurableObject(stub(), (_i: DraftSession, state: DurableObjectState) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
  });

  it("stops scheduling once the draft completes", async () => {
    // A completed session must schedule nothing, or it bills indefinitely.
    await runInDurableObject(stub(), (i: DraftSession) => i.arm({ ...scope, totalPicks: 2 }));
    await writeBatch("b1", "2026-08-30T23:00:01.000Z", [pickMessage(1, 5, 100), pickMessage(2, 2, 101)]);
    await runInDurableObject(stub(), (i: DraftSession) => i.nudge());

    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.complete).toBe(true);

    const alarm = await runInDurableObject(stub(), (_i: DraftSession, state: DurableObjectState) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it("reads only its OWN league's log", async () => {
    // FR-018: enforced by the scoped query, not by a comparison at a call site.
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('other', ?, 'c', '1111111111', ?, 'i', 's', '2026-08-30T23:00:01.000Z', 0, 0, 1, 'pick', ?)`,
    )
      .bind(ACCOUNT, SEASON, JSON.stringify([pickMessage(1, 9, 999)]))
      .run();

    await runInDurableObject(stub(), (i: DraftSession) => i.nudge());
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks).toHaveLength(0);
  });
});
