// 006 T031/T049/T053 — the recommendation endpoints' HTTP contract.
//
// The withholding case is the one worth reading carefully: a withheld response
// is a **200 with empty entries**, not an error status. The question was
// answered, and the answer is "I will not guess". Returning 503 would make
// every client treat a correct, deliberate refusal as a server fault and
// probably retry it.

import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import { issuePairing } from "../../src/db/tap";
import ppr from "../fixtures/espn/settings-team.json";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";
import type { Env } from "../../src/env";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5", NOW_OVERRIDE: "2026-08-15T12:00:00Z" };

async function seed(email: string, withProjections = true) {
  const env = makeEnv(makeEspnStub({ "1001": ppr } as never, { kona, proTeams: proteams }), TEST_ENV);
  const cookie = await signInWithCreds(env, email);
  const created = (await (
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })
  ).json()) as { id: string };
  if (withProjections) {
    await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
  }
  return { env, cookie, id: created.id };
}

interface Board {
  revision: number;
  withheld: { reason: string; detail: string } | null;
  forced: boolean;
  round_value: number;
  freshness: { fetched_at: string; stale: boolean };
  warnings: { kind: string; detail: string }[];
  shortlist: { playerId: number; explanation: { adjustments: { magnitude: number }[] } }[];
  entries: { playerId: number; rank: number; rawValue: number; finalValue: number; preferred: boolean }[];
}

describe("GET /recommendations — the shape", () => {
  it("returns a ranked board with a shortlist head", async () => {
    const { env, cookie, id } = await seed("rec-a@test.co");
    const res = await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Board;

    expect(body.withheld).toBeNull();
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.shortlist.length).toBeGreaterThan(0);
    expect(body.freshness.fetched_at).toBeTruthy();
    expect(typeof body.round_value).toBe("number");
  });

  it("makes `shortlist` exactly the head of `entries`", async () => {
    // The repetition is deliberate — a consumer that only wants the answer
    // reads `shortlist` and never walks `entries` — so they must not disagree.
    const { env, cookie, id } = await seed("rec-b@test.co");
    const body = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;

    const headIds = body.shortlist.map((s) => s.playerId);
    const topIds = body.entries.slice(0, headIds.length).map((e) => e.playerId);
    expect(headIds).toEqual(topIds);
  });

  it("ranks contiguously from 1", async () => {
    const { env, cookie, id } = await seed("rec-c@test.co");
    const body = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    expect(body.entries.map((e) => e.rank)).toEqual(body.entries.map((_, i) => i + 1));
  });

  it("carries the `preferred` flag on entries, so a display can badge below the head", async () => {
    const { env, cookie, id } = await seed("rec-d@test.co");
    const first = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    const target = first.entries.at(-1)!.playerId;

    await api(env, cookie, "PUT", `/api/leagues/${id}/preferred/${target}`);
    const after = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    expect(after.entries.find((e) => e.playerId === target)!.preferred).toBe(true);
  });

  it("409s with `no_projections` when none have been fetched", async () => {
    // Matches `/board`'s existing behaviour for the same cause rather than
    // inventing a second vocabulary.
    const { env, cookie, id } = await seed("rec-e@test.co", false);
    const res = await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("no_projections");
  });
});

describe("ownership", () => {
  it("404s another account's league", async () => {
    const owner = await seed("rec-owner@test.co");
    const intruder = await signInWithCreds(owner.env, "rec-intruder@test.co");
    const res = await api(owner.env, intruder, "GET", `/api/leagues/${owner.id}/recommendations`);
    expect(res.status).toBe(404);
  });

  it("404s an unknown league id", async () => {
    const { env, cookie } = await seed("rec-unknown@test.co");
    expect((await api(env, cookie, "GET", `/api/leagues/does-not-exist/recommendations`)).status).toBe(404);
  });
});

describe("GET /recommendations/players/:playerId — the on-demand explanation (FR-009)", () => {
  it("explains a player far below the shortlist head", async () => {
    const { env, cookie, id } = await seed("rec-explain@test.co");
    const board = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    const deep = board.entries.at(-1)!;

    const res = await api(env, cookie, "GET", `/api/leagues/${id}/recommendations/players/${deep.playerId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playerId: number;
      rank: number;
      explanation: { rawValue: number; finalValue: number; adjustments: { magnitude: number }[] };
    };
    expect(body.playerId).toBe(deep.playerId);
    expect(body.rank).toBe(deep.rank);
    expect(body.explanation).toBeDefined();

    // It reconciles, exactly as a shortlist explanation does — one code path.
    const sum = body.explanation.adjustments.reduce((s, a) => s + a.magnitude, 0);
    expect(body.explanation.finalValue - body.explanation.rawValue).toBeCloseTo(sum, 2);
  });

  it("gives the SAME explanation the shortlist would have given", async () => {
    // Determinism is what makes this true, and it is what lets 008 interrogate
    // any player without the engine emitting an explanation per player per pick.
    const { env, cookie, id } = await seed("rec-same@test.co");
    const board = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    const head = board.shortlist[0]!;

    const one = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations/players/${head.playerId}`)
    ).json()) as { explanation: unknown };
    expect(JSON.stringify(one.explanation)).toBe(JSON.stringify(head.explanation));
  });

  it("404s a player who is not available", async () => {
    const { env, cookie, id } = await seed("rec-404@test.co");
    expect(
      (await api(env, cookie, "GET", `/api/leagues/${id}/recommendations/players/424242`)).status,
    ).toBe(404);
  });

  it("404s a non-numeric id without crashing", async () => {
    const { env, cookie, id } = await seed("rec-nan@test.co");
    expect((await api(env, cookie, "GET", `/api/leagues/${id}/recommendations/players/abc`)).status).toBe(
      404,
    );
  });
});

describe("SC-007 — withholding (FR-012)", () => {
  /** Arm a session, then age its heartbeat past the visible lapse threshold. */
  async function armAndLapse(env: Env, connectionId: string, msAgo: number): Promise<void> {
    const accountRow = await env.DB.prepare(
      `SELECT account_id, espn_league_id, season FROM league_connections WHERE id = ?`,
    )
      .bind(connectionId)
      .first<{ account_id: string; espn_league_id: string; season: number }>();
    await issuePairing(env.DB, accountRow!.account_id, new Date("2026-08-01T00:00:00Z"));
    await env.DB.prepare(
      `INSERT INTO draft_sessions
         (connection_id, account_id, season, status, armed_at, last_heartbeat_at, heartbeat_hidden,
          tap_state, tap_version, consecutive_errors, created_at, updated_at)
       VALUES (?, ?, ?, 'live', ?, ?, 0, 'relaying', '0.1.7', 0, ?, ?)`,
    )
      .bind(
        connectionId,
        accountRow!.account_id,
        accountRow!.season,
        "2026-08-15T11:00:00.000Z",
        new Date(Date.parse(TEST_ENV.NOW_OVERRIDE) - msAgo).toISOString(),
        "2026-08-15T11:00:00.000Z",
        "2026-08-15T11:00:00.000Z",
      )
      .run();
  }

  it("returns 200 with NO entries and a stated reason when the tap has lapsed", async () => {
    const { env, cookie, id } = await seed("rec-withhold@test.co");
    await armAndLapse(env, id, 90_000); // well past the 45 s visible bound

    const res = await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`);
    // NOT an error status: the question was answered.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Board;
    expect(body.withheld).not.toBeNull();
    expect(body.withheld!.reason).toBe("not_receiving");
    expect(body.withheld!.detail.length).toBeGreaterThan(10); // says what to do
    expect(body.entries).toEqual([]);
    expect(body.shortlist).toEqual([]);
  });

  it("does NOT withhold while the heartbeat is fresh", async () => {
    const { env, cookie, id } = await seed("rec-fresh@test.co");
    await armAndLapse(env, id, 5_000);
    const body = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    expect(body.withheld).toBeNull();
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it("withholds the on-demand explanation too", async () => {
    // Otherwise the refusal is trivially bypassable by asking about one player.
    const { env, cookie, id } = await seed("rec-withhold-one@test.co");
    const board = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    const target = board.entries[0]!.playerId;

    await armAndLapse(env, id, 90_000);
    const res = await api(env, cookie, "GET", `/api/leagues/${id}/recommendations/players/${target}`);
    expect(res.status).toBe(404);
  });
});

describe("FR-016 — the revision identifies which state was ranked", () => {
  it("stamps a revision on every board", async () => {
    const { env, cookie, id } = await seed("rec-rev@test.co");
    const body = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    expect(typeof body.revision).toBe("number");
  });

  it("stamps it on a withheld board too, so a consumer knows WHICH state was refused", async () => {
    const { env, cookie, id } = await seed("rec-rev-withheld@test.co");
    await armAndLapseHelper(env, id);
    const body = (await (
      await api(env, cookie, "GET", `/api/leagues/${id}/recommendations`)
    ).json()) as Board;
    expect(body.withheld).not.toBeNull();
    expect(typeof body.revision).toBe("number");
  });

  async function armAndLapseHelper(env: Env, connectionId: string): Promise<void> {
    const row = await env.DB.prepare(
      `SELECT account_id, season FROM league_connections WHERE id = ?`,
    )
      .bind(connectionId)
      .first<{ account_id: string; season: number }>();
    await env.DB.prepare(
      `INSERT INTO draft_sessions
         (connection_id, account_id, season, status, armed_at, last_heartbeat_at, heartbeat_hidden,
          tap_state, tap_version, consecutive_errors, created_at, updated_at)
       VALUES (?, ?, ?, 'live', ?, ?, 0, 'relaying', '0.1.7', 0, ?, ?)`,
    )
      .bind(
        connectionId,
        row!.account_id,
        row!.season,
        "2026-08-15T11:00:00.000Z",
        new Date(Date.parse(TEST_ENV.NOW_OVERRIDE) - 90_000).toISOString(),
        "2026-08-15T11:00:00.000Z",
        "2026-08-15T11:00:00.000Z",
      )
      .run();
  }
});
