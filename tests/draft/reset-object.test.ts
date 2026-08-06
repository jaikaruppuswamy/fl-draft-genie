// 011 T042/T047 — resetting the SESSION OBJECT, and the one flag that separates
// it from a disconnect.
//
// `shutdown()` and `reset()` differ by `closed`, and that single flag is the
// whole feature: `arm()` returns early on `closed`, so shutdown is permanent.
// Before reset existed, the only way to run a second mock draft was to
// disconnect the league and reconnect it — which mints a new connection id, and
// took a preferred player with it on 2026-08-06.
//
// A test that only checks "the picks are gone" passes just as happily against
// `shutdown()`. The assertions that matter here are the ones about what SURVIVES
// and what the session can still do afterwards.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-reset-do";
const CONNECTION = "conn-reset-do";
const MATE = "conn-reset-mate";
const LEAGUE = "8888888888";
const SEASON = 2026;
const ORDER = [3, 1, 4, 2];

const testEnv = env as unknown as Env;

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: 1,
  order: ORDER,
  totalPicks: 24,
};

function stub(connectionId = CONNECTION) {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, connectionId, SEASON));
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

async function writeBatch(id: string, connectionId: string, messages: unknown[]): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO tap_batches
       (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
        received_at, first_seq, last_seq, message_count, kinds, messages_json)
     VALUES (?, ?, ?, ?, ?, 'install-1', 'session-1', ?, 0, 0, ?, 'pick', ?)`,
  )
    .bind(
      id,
      ACCOUNT,
      connectionId,
      LEAGUE,
      SEASON,
      new Date(1_800_000_000_000).toISOString(),
      messages.length,
      JSON.stringify(messages),
    )
    .run();
}

/** Relay `n` picks into one connection's session, as production does. */
async function relay(connectionId: string, n: number, tag: string): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await writeBatch(`${tag}-${String(i).padStart(4, "0")}`, connectionId, [
      pickMessage(i, ORDER[(i - 1) % ORDER.length]!, 5000 + i),
    ]);
    await runInDurableObject(stub(connectionId), (s: DraftSession) => s.nudge());
  }
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "reset-do@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  for (const id of [CONNECTION, MATE]) {
    await runInDurableObject(stub(id), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
  }
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("reset clears the draft (FR-027)", () => {
  it("discards the picks", async () => {
    await relay(CONNECTION, 5, "rd");
    expect((await runInDurableObject(stub(), (s: DraftSession) => s.snapshot()))!.picks).toHaveLength(5);

    await runInDurableObject(stub(), (s: DraftSession) => s.reset());

    const after = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    expect(after?.picks ?? []).toHaveLength(0);
  });

  it("clears a completion belief along with the picks", async () => {
    // A session that resets its picks but keeps `complete` would sit silent
    // through the whole next draft.
    await runInDurableObject(stub(), (s: DraftSession) => s.arm({ ...scope, totalPicks: 4 }));
    await relay(CONNECTION, 4, "rc");
    expect((await runInDurableObject(stub(), (s: DraftSession) => s.snapshot()))!.complete).toBe(true);

    await runInDurableObject(stub(), (s: DraftSession) => s.reset());
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));

    expect((await runInDurableObject(stub(), (s: DraftSession) => s.snapshot()))!.complete).toBe(false);
  });
});

describe("reset is NOT a disconnect — the difference is `closed` (FR-031)", () => {
  it("leaves the session ARMABLE, which shutdown does not", async () => {
    // THE test. `arm()` returns early on `closed`, so if reset ever set that
    // flag — or were quietly implemented as shutdown — the session would look
    // fine and never accept another draft. That is the defect that forced
    // disconnect-and-reconnect in the first place.
    await relay(CONNECTION, 3, "ra");
    await runInDurableObject(stub(), (s: DraftSession) => s.reset());
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));

    await relay(CONNECTION, 2, "rb");
    expect((await runInDurableObject(stub(), (s: DraftSession) => s.snapshot()))!.picks).toHaveLength(2);
  });

  it("PROVES the check can fail — shutdown leaves the session unarmable", async () => {
    // Without this, "leaves the session armable" passes against an
    // implementation that is shutdown by another name, since both clear picks.
    await runInDurableObject(stub(), (s: DraftSession) => s.shutdown());
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));

    await relay(CONNECTION, 2, "rs");
    expect((await runInDurableObject(stub(), (s: DraftSession) => s.snapshot()))?.picks ?? []).toHaveLength(0);
  });

  it("keeps the scope — the league, the season and MY team", async () => {
    // The reset is about the draft, not about who you are in it. Losing
    // `myTeamId` here is the perspective bleed this feature exists to prevent,
    // arriving by a different door.
    await relay(CONNECTION, 3, "rk");
    await runInDurableObject(stub(), (s: DraftSession) => s.reset());

    const kept = await runInDurableObject(stub(), (_i: DraftSession, state: DurableObjectState) =>
      state.storage.get<SessionScope>("scope"),
    );
    expect(kept?.myTeamId).toBe(1);
    expect(kept?.espnLeagueId).toBe(LEAGUE);
  });
});

describe("reset is PER MANAGER under fan-out (T047)", () => {
  it("does not disturb a leaguemate's session in the SAME league", async () => {
    // Under fan-out both sessions are fed the same frames, so this is the case
    // that matters: same league, same season, different connection. If reset
    // ever moved to a league key, one manager starting over would wipe the
    // board of everyone else mid-draft.
    await runInDurableObject(stub(MATE), (i: DraftSession) =>
      i.arm({ ...scope, connectionId: MATE, myTeamId: 4 }),
    );
    await relay(CONNECTION, 4, "mine");
    await relay(MATE, 4, "theirs");

    await runInDurableObject(stub(), (s: DraftSession) => s.reset());

    expect((await runInDurableObject(stub(), (s: DraftSession) => s.snapshot()))?.picks ?? []).toHaveLength(0);
    expect((await runInDurableObject(stub(MATE), (s: DraftSession) => s.snapshot()))!.picks).toHaveLength(4);
  });

  it("leaves the leaguemate's own team intact", async () => {
    await runInDurableObject(stub(MATE), (i: DraftSession) =>
      i.arm({ ...scope, connectionId: MATE, myTeamId: 4 }),
    );
    await runInDurableObject(stub(), (s: DraftSession) => s.reset());

    const mate = await runInDurableObject(stub(MATE), (_i: DraftSession, state: DurableObjectState) =>
      state.storage.get<SessionScope>("scope"),
    );
    expect(mate?.myTeamId).toBe(4);
  });
});
