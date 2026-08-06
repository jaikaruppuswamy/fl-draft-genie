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
const OTHER = "someone-else";
const LEAGUE = "9999999999";
const SEASON = 2026;

/** The reader's own connection: verified member of LEAGUE. */
const CONN = "conn-feed-mine";
/** A leaguemate in the SAME league, also verified. Their frames are shared. */
const CONN_MATE = "conn-feed-mate";
/** Same league, but the team was CHOSEN from a list, not matched by SWID. */
const CONN_MANUAL = "conn-feed-manual";
/** A verified member of a DIFFERENT league. */
const CONN_ELSEWHERE = "conn-feed-elsewhere";

async function insert(
  id: string,
  receivedAt: string,
  messages: unknown[] = [],
  seq = 1,
  account = ACCOUNT,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tap_batches
       (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
        received_at, first_seq, last_seq, message_count, kinds, messages_json)
     VALUES (?, ?, 'conn-1', ?, ?, 'install-1', 'session-1', ?, ?, ?, ?, 'pick', ?)`,
  )
    .bind(id, account, LEAGUE, SEASON, receivedAt, seq, seq, messages.length, JSON.stringify(messages))
    .run();
}

async function connection(id: string, account: string, league: string, source: "auto" | "manual"): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO league_connections
       (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'ok')`,
  )
    .bind(id, account, league, SEASON, source, "2026-08-01T00:00:00.000Z")
    .run();
}

const scope = { readerConnectionId: CONN, espnLeagueId: LEAGUE, season: SEASON };

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
    .bind(OTHER, "other@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  // This suite shares a database with others, so the teardown above is scoped by
  // account — and now a leaguemate relays too, so their rows need clearing as
  // well or they leak into the next test.
  await env.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(OTHER).run();

  await connection(CONN, ACCOUNT, LEAGUE, "auto");
  await connection(CONN_MATE, OTHER, LEAGUE, "auto");
  await connection(CONN_MANUAL, OTHER, LEAGUE, "manual");
  await connection(CONN_ELSEWHERE, OTHER, "1111111111", "auto");
});

describe("readBatchesAfter", () => {
  it("returns everything, oldest first, when there is no cursor", async () => {
    await insert("tf-b2", "2026-08-30T23:00:02.000Z");
    await insert("tf-b1", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, scope, null);
    expect(rows.map((r) => r.id)).toEqual(["tf-b1", "tf-b2"]);
  });

  it("returns only what is strictly after the cursor", async () => {
    await insert("tf-b1", "2026-08-30T23:00:01.000Z");
    await insert("tf-b2", "2026-08-30T23:00:02.000Z");
    const rows = await readBatchesAfter(env.DB, scope, { receivedAt: "2026-08-30T23:00:01.000Z", id: "tf-b1" });
    expect(rows.map((r) => r.id)).toEqual(["tf-b2"]);
  });

  it("breaks a same-millisecond tie by id, so neither row is lost nor replayed", async () => {
    // Autodraft produced ~1 pick/second in a real draft and batches can share a
    // timestamp. Without the id tiebreak one of these is either skipped forever
    // or re-read forever.
    await insert("tf-a", "2026-08-30T23:00:01.000Z");
    await insert("tf-b", "2026-08-30T23:00:01.000Z");
    await insert("tf-c", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, scope, { receivedAt: "2026-08-30T23:00:01.000Z", id: "tf-a" });
    expect(rows.map((r) => r.id)).toEqual(["tf-b", "tf-c"]);
  });

  it("does NOT skip a row inserted between reads", async () => {
    // The offset-pagination bug this design exists to avoid.
    await insert("tf-b1", "2026-08-30T23:00:01.000Z");
    const first = await readBatchesAfter(env.DB, scope, null);
    const cursor = { receivedAt: first.at(-1)!.receivedAt, id: first.at(-1)!.id };
    await insert("tf-b0", "2026-08-30T23:00:00.500Z"); // lands EARLIER than the cursor
    await insert("tf-b2", "2026-08-30T23:00:02.000Z");
    const second = await readBatchesAfter(env.DB, scope, cursor);
    // b0 is genuinely before the cursor and correctly not re-read; b2 is after.
    expect(second.map((r) => r.id)).toEqual(["tf-b2"]);
  });

  // 011 Phase 3 replaced the account boundary with a LEAGUE boundary plus a
  // membership test. The old assertion here ("scoped to the account, so one
  // owner's draft cannot feed another's") asserted the behaviour that was
  // deliberately removed, so it is rewritten rather than deleted — it is the
  // only regression guard standing on this seam, and deleting it is exactly
  // what a mechanical fix would have done.
  //
  // The rule now: a league's picks are shared among that league's managers
  // (constitution, ratified 2026-08-06), and entitlement is VERIFIED MEMBERSHIP
  // — ESPN's own owner list carrying the account's SWID.

  it("SHARES a leaguemate's frames — the whole point of fan-out", async () => {
    // Written under a different account entirely. Before 011 this returned
    // nothing, and a manager without a tap saw an empty board.
    await insert("tf-mate", "2026-08-30T23:00:01.000Z", [], 1, OTHER);
    const rows = await readBatchesAfter(env.DB, scope, null);
    expect(rows.map((r) => r.id)).toEqual(["tf-mate"]);
  });

  it("REFUSES a reader whose team was chosen manually, not matched by SWID", async () => {
    // The boundary that replaces the account predicate. A league id is
    // guessable and connecting proves nothing, so holding a connection row is
    // not membership. 'manual' means the automatic match failed and the user
    // picked from a list — fine for their own league, not evidence of belonging.
    await insert("tf-mine", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, { ...scope, readerConnectionId: CONN_MANUAL }, null);
    expect(rows).toEqual([]);
  });

  it("REFUSES a reader whose connection is for a different league", async () => {
    await insert("tf-mine", "2026-08-30T23:00:01.000Z");
    const rows = await readBatchesAfter(env.DB, { ...scope, readerConnectionId: CONN_ELSEWHERE }, null);
    expect(rows).toEqual([]);
  });

  it("REFUSES an unknown connection", async () => {
    await insert("tf-mine", "2026-08-30T23:00:01.000Z");
    expect(await readBatchesAfter(env.DB, { ...scope, readerConnectionId: "nope" }, null)).toEqual([]);
  });

  it("is still scoped to the league and season", async () => {
    await insert("tf-mine", "2026-08-30T23:00:01.000Z");
    expect(await readBatchesAfter(env.DB, { ...scope, espnLeagueId: "1111111111" }, null)).toEqual([]);
    expect(await readBatchesAfter(env.DB, { ...scope, season: 2025 }, null)).toEqual([]);
  });

  it("PROVES the refusals are conditional, not blanket", async () => {
    // Every negative above passes against a function that returns [] for
    // everything. This is the companion that makes them mean something: the
    // SAME fixture, read by an entitled connection, returns the row.
    await insert("tf-mine", "2026-08-30T23:00:01.000Z");
    expect((await readBatchesAfter(env.DB, scope, null)).length).toBeGreaterThan(0);
  });

  it("never hands the caller the relayer's device identity (FR-003, SC-003)", async () => {
    // Not selected at all, so SC-003 holds by construction rather than by
    // nobody downstream having reached for these fields.
    await insert("tf-mate", "2026-08-30T23:00:01.000Z", [], 1, OTHER);
    const row = (await readBatchesAfter(env.DB, scope, null))[0]!;
    expect(Object.keys(row)).not.toContain("installId");
    expect(Object.keys(row)).not.toContain("sessionId");
    expect(JSON.stringify(row)).not.toContain("install-1");
  });

  it("honours the limit so one read cannot pull an unbounded draft", async () => {
    for (let i = 0; i < 10; i++) await insert(`tf-${i}`, `2026-08-30T23:00:0${i}.000Z`);
    const rows = await readBatchesAfter(env.DB, scope, null, 3);
    expect(rows).toHaveLength(3);
  });

  it("decodes the relayed messages", async () => {
    const msg = { v: 1, seq: 4, epoch: 0, observedAt: "x", transport: "ws", kind: "pick", payload: { playerId: -16007 } };
    await insert("tf-b1", "2026-08-30T23:00:01.000Z", [msg]);
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
       VALUES ('tf-bad', ?, 'c', ?, ?, 'i', 's', '2026-08-30T23:00:01.000Z', 1, 1, 1, 'pick', '{not json')`,
    )
      .bind(ACCOUNT, LEAGUE, SEASON)
      .run();
    const rows = await readBatchesAfter(env.DB, scope, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messages).toEqual([]);
  });
});
