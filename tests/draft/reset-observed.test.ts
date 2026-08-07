// 011 T048 — what ESPN has to say before a draft is voided.
//
// THE TEST THIS FILE EXISTS FOR is "never voids a draft that is RUNNING". It is
// not hypothetical: `tests/fixtures/espn/draft/open.json` is a capture of a live
// draft, and it reads `drafted: false`, 72 rows, 0 filled picks — identical to a
// post-reset body on every field except `inProgress`. The obvious rule, and the
// one this task's own description suggests, wipes it. Under league-shared
// delivery that destroys every manager's board at once, mid-draft, and the void
// moves the log floor so it cannot be undone.
//
// The measurements this is built on come from a real reset (011 T001,
// 2026-08-07): `drafted` does return to false, the pick skeleton is REBUILT
// rather than shortened (72 rows, 0 filled, every playerId back to -1), and
// ESPN's draft date is cleared.

import { describe, expect, it } from "vitest";
import openDraft from "../fixtures/espn/draft/open.json";
import { classifyReset, filledPickCount, type ResetInput } from "../../src/sync/resetObserved";

const NOW = "2026-08-07T12:00:00.000Z";
const COMPLETED_AT = "2026-08-06T04:30:00.000Z";
const SUSPECTED_AT = "2026-08-07T11:45:00.000Z";

/** A rebuilt board: the exact shape T001 measured after a real reset. */
const skeleton = (n = 72) => Array.from({ length: n }, (_, i) => ({ playerId: -1, overallPickNumber: i + 1 }));

/** A finished board, including a D/ST whose id is legitimately negative. */
const filledBoard = (n = 72) =>
  Array.from({ length: n }, (_, i) => ({ playerId: i === 5 ? -16007 : 4000000 + i, overallPickNumber: i + 1 }));

const input = (over: Partial<ResetInput> = {}): ResetInput => ({
  espnCompletedAt: COMPLETED_AT,
  suspectedAt: SUSPECTED_AT,
  draftDetail: { drafted: false, inProgress: false, picks: skeleton() },
  identityMatches: true,
  anyLive: false,
  awaitingArchive: false,
  supportedDraftType: true,
  now: NOW,
  ...over,
});

describe("a LIVE draft is never voided (FR-031d)", () => {
  it("ignores the real live-draft capture, which looks exactly like a reset", () => {
    // The whole reason memory is required. This fixture is a draft in progress:
    // drafted false, 72 rows, nothing filled. Only `inProgress` and the absence
    // of a prior completion tell it apart from a reset.
    const dd = (openDraft as { draftDetail: { picks: { playerId?: unknown }[] } }).draftDetail;
    expect(filledPickCount(dd.picks)).toBe(0);
    expect(dd.picks.length).toBeGreaterThan(0);

    // A draft that has never finished has no memory of finishing.
    const r = classifyReset(input({ espnCompletedAt: null, draftDetail: dd }));
    expect(r).toEqual({ kind: "ignore", why: "no_memory" });
  });

  it("refuses while any session in the league is live, even with memory set", () => {
    expect(classifyReset(input({ anyLive: true }))).toEqual({ kind: "ignore", why: "draft_is_live" });
  });

  it("refuses while a completed draft is still waiting to be archived", () => {
    // The void moves the log floor to the log's current tip, so voiding inside
    // this window is unrecoverable — the frames survive and nothing can reach
    // them. Deferring costs one cron interval.
    expect(classifyReset(input({ awaitingArchive: true }))).toEqual({ kind: "ignore", why: "awaiting_archive" });
  });
});

describe("an ambiguous report voids nothing (FR-031f)", () => {
  // Each of these is a way the answer can be "we do not know", and every one of
  // them must be distinguishable from "ESPN said no".
  const cases: [string, Partial<ResetInput>, string][] = [
    ["draftDetail missing entirely", { draftDetail: null }, "no_draft_detail"],
    ["draftDetail is not an object", { draftDetail: "nope" }, "no_draft_detail"],
    ["drafted absent", { draftDetail: { inProgress: false, picks: skeleton() } }, "drafted_absent"],
    ["drafted not a boolean", { draftDetail: { drafted: 0, inProgress: false, picks: skeleton() } }, "drafted_absent"],
    ["inProgress absent", { draftDetail: { drafted: false, picks: skeleton() } }, "in_progress_absent"],
    ["picks absent", { draftDetail: { drafted: false, inProgress: false } }, "no_picks_array"],
    ["picks empty — a published but unstarted draft", { draftDetail: { drafted: false, inProgress: false, picks: [] } }, "no_picks_array"],
    ["a different league or season answered", { identityMatches: false }, "identity_mismatch"],
    ["an unmeasured draft type", { supportedDraftType: false }, "unsupported_draft_type"],
  ];

  for (const [name, over, why] of cases) {
    it(`ignores: ${name}`, () => {
      expect(classifyReset(input(over))).toEqual({ kind: "ignore", why });
    });
  }

  it("ignores a draft ESPN still reports as complete", () => {
    expect(classifyReset(input({ draftDetail: { drafted: true, inProgress: false, picks: filledBoard() } }))).toEqual({
      kind: "ignore",
      why: "still_drafted",
    });
  });

  it("ignores a board that still has picks on it", () => {
    expect(
      classifyReset(input({ draftDetail: { drafted: false, inProgress: false, picks: filledBoard() } })),
    ).toEqual({ kind: "ignore", why: "picks_still_filled" });
  });
});

describe("detection keys on a CHANGE in ESPN's report (FR-031a1)", () => {
  it("does nothing without a remembered completion", () => {
    // Not a disagreement between us and ESPN — a change in what ESPN itself
    // says. Mocks never appear in ESPN's league record at all, so a
    // disagreement rule fires endlessly for them.
    expect(classifyReset(input({ espnCompletedAt: null }))).toEqual({ kind: "ignore", why: "no_memory" });
  });

  it("SUSPECTS on the first qualifying observation, and does not void", () => {
    // Production reads ESPN once per sync; the gate needed three reads before
    // it would call a report unambiguous. One observation is not enough to
    // destroy a league's boards.
    expect(classifyReset(input({ suspectedAt: null }))).toEqual({ kind: "suspect" });
  });

  it("VOIDS on the second — PROVES the rule is not simply closed", () => {
    // Without this every refusal above passes against a classifier that never
    // voids anything, and US8 would not exist.
    const r = classifyReset(input());
    expect(r.kind).toBe("void");
    if (r.kind === "void") {
      expect(r.reason).toBe("espn_reset_idle");
      expect(r.observedFilled).toBe(0);
      expect(r.rows).toBe(72);
    }
  });

  it("names re-drafting apart from idle", () => {
    // ESPN cannot run a draft in a league it previously reported complete
    // unless it was reset — and those sessions are already contaminated, since
    // they hold a completion stamp that stops them ever reporting live again.
    const r = classifyReset(input({ draftDetail: { drafted: false, inProgress: true, picks: skeleton() } }));
    expect(r.kind).toBe("void");
    if (r.kind === "void") expect(r.reason).toBe("espn_reset_redrafting");
  });
});

describe("counting filled picks", () => {
  it("keeps D/ST picks, whose ids are legitimately negative", () => {
    // `playerId > 0` is what made 010's capture report 66 of 72 picks for a
    // complete draft. Only the exact skeleton value is excluded.
    expect(filledPickCount([{ playerId: -16007 }, { playerId: 4262921 }])).toBe(2);
  });

  it("excludes the skeleton, and only the skeleton", () => {
    expect(filledPickCount(skeleton(5))).toBe(0);
    expect(filledPickCount([...skeleton(3), { playerId: -16007 }])).toBe(1);
  });

  it("does NOT use the array length", () => {
    // The measurement that shapes this: a reset rebuilds the board rather than
    // emptying it, so length says 72 either way.
    expect(skeleton(72)).toHaveLength(72);
    expect(filledPickCount(skeleton(72))).toBe(0);
  });
});

// --- the void itself (T052, T053) -------------------------------------------

import { env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { voidLeagueSessions } from "../../src/db/draft";
import type { Env } from "../../src/env";

const testEnv = env as unknown as Env;
const V_LEAGUE = "7171717171";
const V_SEASON = 2026;
const MANAGERS = [
  { account: "acct-void-a", conn: "conn-void-a" },
  { account: "acct-void-b", conn: "conn-void-b" },
];

describe("a confirmed reset voids EVERY manager (T052, FR-031b)", () => {
  beforeEach(async () => {
    for (const m of MANAGERS) {
      await testEnv.DB.prepare("INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)")
        .bind(m.account, `${m.account}@void.test`, "2026-08-01T00:00:00.000Z")
        .run();
      await testEnv.DB.prepare(
        `INSERT OR IGNORE INTO league_connections
           (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
         VALUES (?, ?, ?, ?, 1, 'auto', ?, 'ok')`,
      )
        .bind(m.conn, m.account, V_LEAGUE, V_SEASON, "2026-08-01T00:00:00.000Z")
        .run();
      await testEnv.DB.prepare(
        `INSERT OR REPLACE INTO draft_sessions
           (connection_id, account_id, season, status, completed_at, updated_at, created_at, heartbeat_hidden)
         VALUES (?, ?, ?, 'complete', ?, ?, ?, 0)`,
      )
        .bind(m.conn, m.account, V_SEASON, "2026-08-06T05:00:00.000Z", NOW, NOW)
        .run();
    }
  });

  it("clears the completion stamp for every connection in the league", async () => {
    // Not only the one whose sync noticed. Under fan-out they were all fed the
    // same frames, and leaving the others holding the old draft is the
    // contamination this feature exists to end, arriving by another door.
    const voided = await voidLeagueSessions(testEnv.DB, V_LEAGUE, V_SEASON, new Date(NOW));
    expect(voided.sort()).toEqual(MANAGERS.map((m) => m.conn).sort());

    for (const m of MANAGERS) {
      const row = await testEnv.DB.prepare("SELECT status, completed_at FROM draft_sessions WHERE connection_id = ?")
        .bind(m.conn)
        .first<{ status: string; completed_at: string | null }>();
      expect(row?.completed_at, m.conn).toBeNull();
      expect(row?.status, m.conn).not.toBe("complete");
    }
  });

  it("leaves ANOTHER league alone — PROVES the void is scoped", async () => {
    // Without this, "voids every manager" passes against a statement with no
    // WHERE clause, which would clear every session in the database.
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO league_connections
         (id, account_id, espn_league_id, season, my_team_id, team_match_source, created_at, last_sync_status)
       VALUES ('conn-void-other', ?, '7272727272', ?, 1, 'auto', ?, 'ok')`,
    )
      .bind(MANAGERS[0]!.account, V_SEASON, "2026-08-01T00:00:00.000Z")
      .run();
    await testEnv.DB.prepare(
      `INSERT OR REPLACE INTO draft_sessions
         (connection_id, account_id, season, status, completed_at, updated_at, created_at, heartbeat_hidden)
       VALUES ('conn-void-other', ?, ?, 'complete', ?, ?, ?, 0)`,
    )
      .bind(MANAGERS[0]!.account, V_SEASON, "2026-08-06T05:00:00.000Z", NOW, NOW)
      .run();

    await voidLeagueSessions(testEnv.DB, V_LEAGUE, V_SEASON, new Date(NOW));

    const other = await testEnv.DB.prepare("SELECT completed_at FROM draft_sessions WHERE connection_id = ?")
      .bind("conn-void-other")
      .first<{ completed_at: string | null }>();
    expect(other?.completed_at).not.toBeNull();
  });

  it("destroys NO capture history (T053, FR-031c)", async () => {
    // A draft that really happened stays history. 008's corpus may already
    // depend on these rows, and the frames are the only record that survives a
    // session being cleared.
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES ('void-batch', ?, ?, ?, ?, 'i', 's', ?, 1, 1, 1, 'pick', '[]')`,
    )
      .bind(MANAGERS[0]!.account, MANAGERS[0]!.conn, V_LEAGUE, V_SEASON, NOW)
      .run();

    await voidLeagueSessions(testEnv.DB, V_LEAGUE, V_SEASON, new Date(NOW));

    const kept = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM tap_batches WHERE espn_league_id = ?")
      .bind(V_LEAGUE)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });

  it("forgets the completion memory, so the league leaves the watch", async () => {
    // Otherwise it would be re-examined forever, and a genuinely new draft
    // could never set the memory again.
    for (const m of MANAGERS) {
      await testEnv.DB.prepare(
        `INSERT OR REPLACE INTO league_snapshots
           (connection_id, captured_at, league_name, team_count, scoring_json, roster_json, draft_json, teams_json,
            draft_at, espn_draft_completed_at, espn_reset_suspected_at)
         VALUES (?, ?, 'L', 2, '{}', '{}', '{"supported":true}', '[]', NULL, ?, ?)`,
      )
        .bind(m.conn, NOW, COMPLETED_AT, SUSPECTED_AT)
        .run();
    }

    await voidLeagueSessions(testEnv.DB, V_LEAGUE, V_SEASON, new Date(NOW));

    for (const m of MANAGERS) {
      const s = await testEnv.DB.prepare(
        "SELECT espn_draft_completed_at, espn_reset_suspected_at FROM league_snapshots WHERE connection_id = ?",
      )
        .bind(m.conn)
        .first<{ espn_draft_completed_at: string | null; espn_reset_suspected_at: string | null }>();
      expect(s?.espn_draft_completed_at, m.conn).toBeNull();
      expect(s?.espn_reset_suspected_at, m.conn).toBeNull();
    }
  });
});
