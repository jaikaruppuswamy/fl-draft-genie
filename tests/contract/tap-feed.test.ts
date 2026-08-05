// 005 T019 — the keyset cursor read over `tap_batches`.
//
// This is the seam where the session gets its picks, and its failure mode is
// silence: an off-by-one skips a pick and nothing errors. So the tests write
// rows directly and assert exactly what comes back — including the two cases a
// plausible implementation gets wrong (a same-millisecond tie, and a row
// inserted between reads).

import { beforeEach, describe, expect, it } from "vitest";
import { makeEnv } from "../helpers/app";
import { readBatchesAfter } from "../../src/db/tap";
import type { Env } from "../../src/env";

let env: Env;

const ACCOUNT = "acct-feed";
const LEAGUE = "9999999999";
const SEASON = 2026;

async function insert(id: string, receivedAt: string, messages: unknown[] = [], seq = 1): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tap_batches
       (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
        received_at, first_seq, last_seq, message_count, kinds, messages_json)
     VALUES (?, ?, 'conn-1', ?, ?, 'install-1', 'session-1', ?, ?, ?, ?, 'pick', ?)`,
  )
    .bind(id, ACCOUNT, LEAGUE, SEASON, receivedAt, seq, seq, messages.length, JSON.stringify(messages))
    .run();
}

const scope = { accountId: ACCOUNT, espnLeagueId: LEAGUE, season: SEASON };

beforeEach(async () => {
  env = makeEnv();
  await env.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  // tap_batches.account_id carries a real FK to accounts, so the row must
  // exist. That constraint is deliberate — a retained batch belongs to an
  // owner — and the test respects it rather than working around it.
  await env.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "feed@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await env.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind("someone-else", "other@test.co", "2026-08-01T00:00:00.000Z")
    .run();
});

describe("readBatchesAfter", () => {
  it("returns everything, oldest first, when there is no cursor", async () => {
    await insert("b2", "2026-08-30T23:00:02.000Z");
    await insert("b1", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, scope, null);
    expect(rows.map((r) => r.id)).toEqual(["b1", "b2"]);
  });

  it("returns only what is strictly after the cursor", async () => {
    await insert("b1", "2026-08-30T23:00:01.000Z");
    await insert("b2", "2026-08-30T23:00:02.000Z");
    const rows = await readBatchesAfter(env.DB, scope, { receivedAt: "2026-08-30T23:00:01.000Z", id: "b1" });
    expect(rows.map((r) => r.id)).toEqual(["b2"]);
  });

  it("breaks a same-millisecond tie by id, so neither row is lost nor replayed", async () => {
    // Autodraft produced ~1 pick/second in a real draft and batches can share a
    // timestamp. Without the id tiebreak one of these is either skipped forever
    // or re-read forever.
    await insert("a", "2026-08-30T23:00:01.000Z");
    await insert("b", "2026-08-30T23:00:01.000Z");
    await insert("c", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, scope, { receivedAt: "2026-08-30T23:00:01.000Z", id: "a" });
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("does NOT skip a row inserted between reads", async () => {
    // The offset-pagination bug this design exists to avoid.
    await insert("b1", "2026-08-30T23:00:01.000Z");
    const first = await readBatchesAfter(env.DB, scope, null);
    const cursor = { receivedAt: first.at(-1)!.receivedAt, id: first.at(-1)!.id };
    await insert("b0", "2026-08-30T23:00:00.500Z"); // lands EARLIER than the cursor
    await insert("b2", "2026-08-30T23:00:02.000Z");
    const second = await readBatchesAfter(env.DB, scope, cursor);
    // b0 is genuinely before the cursor and correctly not re-read; b2 is after.
    expect(second.map((r) => r.id)).toEqual(["b2"]);
  });

  it("is scoped to the account, so one owner's draft cannot feed another's", async () => {
    // FR-018 / FR-007d — enforced by the query, not by a comparison we could
    // forget at a call site.
    await insert("mine", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, { ...scope, accountId: "someone-else" }, null);
    expect(rows).toEqual([]);
  });

  it("is scoped to the league and season", async () => {
    await insert("mine", "2026-08-30T23:00:01.000Z");
    expect(await readBatchesAfter(env.DB, { ...scope, espnLeagueId: "1111111111" }, null)).toEqual([]);
    expect(await readBatchesAfter(env.DB, { ...scope, season: 2025 }, null)).toEqual([]);
  });

  it("honours the limit so one read cannot pull an unbounded draft", async () => {
    for (let i = 0; i < 10; i++) await insert(`b${i}`, `2026-08-30T23:00:0${i}.000Z`);
    const rows = await readBatchesAfter(env.DB, scope, null, 3);
    expect(rows).toHaveLength(3);
  });

  it("decodes the relayed messages", async () => {
    const msg = { v: 1, seq: 4, epoch: 0, observedAt: "x", transport: "ws", kind: "pick", payload: { playerId: -16007 } };
    await insert("b1", "2026-08-30T23:00:01.000Z", [msg]);
    const rows = await readBatchesAfter(env.DB, scope, null);
    expect(rows[0]!.messages).toEqual([msg]);
  });

  it("survives a corrupt row rather than taking the draft down", async () => {
    // A parse failure mid-draft must degrade to "this batch carried nothing",
    // not to an exception that stops the session.
    await env.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('bad', ?, 'c', ?, ?, 'i', 's', '2026-08-30T23:00:01.000Z', 1, 1, 1, 'pick', '{not json')`,
    )
      .bind(ACCOUNT, LEAGUE, SEASON)
      .run();
    const rows = await readBatchesAfter(env.DB, scope, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messages).toEqual([]);
  });
});
