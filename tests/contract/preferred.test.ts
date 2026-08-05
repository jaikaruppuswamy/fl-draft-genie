// 006 T043/T044 — the preferred-player list's HTTP contract (FR-018/019/020/021).
//
// THE ISOLATION TEST REQUIRES 404, NOT AN EMPTY LIST.
//
// That distinction is the whole test. An empty list confirms the connection
// exists — it tells the requester they guessed a real id, which is exactly the
// information the constitution's privacy section says one owner must never get
// about another. `readBatchesAfter` established the pattern during 005 and this
// follows it: the query cannot see the row, and the route cannot see the league.

import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import ppr from "../fixtures/espn/settings-team.json";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5", NOW_OVERRIDE: "2026-08-15T12:00:00Z" };

async function seed(email: string) {
  const env = makeEnv(makeEspnStub({ "1001": ppr } as never, { kona, proTeams: proteams }), TEST_ENV);
  const cookie = await signInWithCreds(env, email);
  const created = (await (
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })
  ).json()) as { id: string };
  await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
  return { env, cookie, id: created.id };
}

/** A player id that genuinely exists on the seeded board. */
async function aPlayerId(env: ReturnType<typeof makeEnv>, cookie: string, id: string): Promise<number> {
  const board = (await (await api(env, cookie, "GET", `/api/leagues/${id}/board`)).json()) as {
    players: { espn_player_id: number }[];
  };
  return board.players[0]!.espn_player_id;
}

describe("SC-011 — the list persists", () => {
  it("starts empty, accepts an add, and survives a fresh read", async () => {
    const { env, cookie, id } = await seed("pref-a@test.co");
    const playerId = await aPlayerId(env, cookie, id);

    const before = (await (await api(env, cookie, "GET", `/api/leagues/${id}/preferred`)).json()) as {
      players: unknown[];
    };
    expect(before.players).toEqual([]);

    expect((await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`)).status).toBe(204);

    const after = (await (await api(env, cookie, "GET", `/api/leagues/${id}/preferred`)).json()) as {
      players: { espn_player_id: number; on_board: boolean; name: string | null }[];
    };
    expect(after.players).toHaveLength(1);
    expect(after.players[0]!.espn_player_id).toBe(playerId);
    expect(after.players[0]!.on_board).toBe(true);
    expect(after.players[0]!.name).not.toBeNull();
  });

  it("survives a NEW SESSION for the same account", async () => {
    const { env, cookie, id } = await seed("pref-b@test.co");
    const playerId = await aPlayerId(env, cookie, id);
    await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`);

    // Sign in again — a different cookie, the same owner.
    const second = await signInWithCreds(env, "pref-b@test.co");
    const list = (await (await api(env, second, "GET", `/api/leagues/${id}/preferred`)).json()) as {
      players: unknown[];
    };
    expect(list.players).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("adds twice without error and holds one row", async () => {
    const { env, cookie, id } = await seed("pref-c@test.co");
    const playerId = await aPlayerId(env, cookie, id);
    await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`);
    expect((await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`)).status).toBe(204);
    const list = (await (await api(env, cookie, "GET", `/api/leagues/${id}/preferred`)).json()) as {
      players: unknown[];
    };
    expect(list.players).toHaveLength(1);
  });

  it("removes twice without error", async () => {
    const { env, cookie, id } = await seed("pref-d@test.co");
    const playerId = await aPlayerId(env, cookie, id);
    await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`);
    expect((await api(env, cookie, "DELETE", `/api/leagues/${id}/preferred/${playerId}`)).status).toBe(204);
    // Already gone — still 204, because the caller's intent is satisfied.
    expect((await api(env, cookie, "DELETE", `/api/leagues/${id}/preferred/${playerId}`)).status).toBe(204);
    const list = (await (await api(env, cookie, "GET", `/api/leagues/${id}/preferred`)).json()) as {
      players: unknown[];
    };
    expect(list.players).toEqual([]);
  });

  it("404s an add for a player who is not on the board at all", async () => {
    const { env, cookie, id } = await seed("pref-e@test.co");
    expect((await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/424242`)).status).toBe(404);
  });

  it("404s a non-numeric player id without crashing", async () => {
    const { env, cookie, id } = await seed("pref-f@test.co");
    expect((await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/not-a-number`)).status).toBe(404);
  });
});

describe("FR-020 — isolation between accounts", () => {
  it("returns 404 for another account's league, NOT an empty list", async () => {
    // An empty list would confirm the connection exists. That is the leak.
    const owner = await seed("pref-owner@test.co");
    const playerId = await aPlayerId(owner.env, owner.cookie, owner.id);
    await api(owner.env, owner.cookie, "PUT", `/api/leagues/${owner.id}/preferred/${playerId}`);

    const intruder = await signInWithCreds(owner.env, "pref-intruder@test.co");

    const read = await api(owner.env, intruder, "GET", `/api/leagues/${owner.id}/preferred`);
    expect(read.status).toBe(404);

    const write = await api(owner.env, intruder, "PUT", `/api/leagues/${owner.id}/preferred/${playerId}`);
    expect(write.status).toBe(404);

    const remove = await api(owner.env, intruder, "DELETE", `/api/leagues/${owner.id}/preferred/${playerId}`);
    expect(remove.status).toBe(404);

    // And the owner's list is untouched by any of it.
    const still = (await (
      await api(owner.env, owner.cookie, "GET", `/api/leagues/${owner.id}/preferred`)
    ).json()) as { players: unknown[] };
    expect(still.players).toHaveLength(1);
  });

  it("keeps two owners' lists entirely separate", async () => {
    const a = await seed("pref-two-a@test.co");
    const playerId = await aPlayerId(a.env, a.cookie, a.id);
    await api(a.env, a.cookie, "PUT", `/api/leagues/${a.id}/preferred/${playerId}`);

    // A second owner connects the SAME ESPN league — a different connection row.
    const bCookie = await signInWithCreds(a.env, "pref-two-b@test.co");
    const bLeague = (await (
      await api(a.env, bCookie, "POST", "/api/leagues", { league_ref: "1001" })
    ).json()) as { id: string };

    const bList = (await (await api(a.env, bCookie, "GET", `/api/leagues/${bLeague.id}/preferred`)).json()) as {
      players: unknown[];
    };
    expect(bList.players).toEqual([]);
  });

  it("requires authentication at all", async () => {
    const { env, id } = await seed("pref-anon@test.co");
    const res = await api(env, "", "GET", `/api/leagues/${id}/preferred`);
    expect([401, 403]).toContain(res.status);
  });
});

describe("FR-021 — a preferred player who leaves the board", () => {
  it("keeps the row and reports on_board: false", async () => {
    const { env, cookie, id } = await seed("pref-gone@test.co");
    const playerId = await aPlayerId(env, cookie, id);
    await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`);

    // The player is released — deactivated on the board, exactly as 002's
    // refresh would do. The owner's intent must NOT be erased behind their back.
    await env.DB.prepare(`UPDATE players SET active = 0 WHERE espn_player_id = ?`).bind(playerId).run();

    const list = (await (await api(env, cookie, "GET", `/api/leagues/${id}/preferred`)).json()) as {
      players: { espn_player_id: number; on_board: boolean; name: string | null }[];
    };
    expect(list.players).toHaveLength(1);
    expect(list.players[0]!.espn_player_id).toBe(playerId);
    expect(list.players[0]!.on_board).toBe(false);
    expect(list.players[0]!.name).toBeNull();
  });

  it("leaves the ranking unaffected — the engine simply never recommends them", async () => {
    const { env, cookie, id } = await seed("pref-inert@test.co");
    const playerId = await aPlayerId(env, cookie, id);

    const before = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as { entries: { player_id?: number; playerId?: number }[] };

    await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${playerId}`);
    await env.DB.prepare(`UPDATE players SET active = 0 WHERE espn_player_id = ?`).bind(playerId).run();

    const after = await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`);
    expect(after.status).toBe(200);
    const body = (await after.json()) as { entries: unknown[] };
    // One fewer player on the board, and no crash.
    expect(body.entries.length).toBe(before.entries.length - 1);
  });
});
