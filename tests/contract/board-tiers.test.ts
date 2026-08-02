// 003 US2: tiers on the board — format-specific feeds, name matching,
// graceful degradation (FR-002/003/004).

import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import { ingestTiers } from "../../src/tiers/borischen";
import ppr from "../fixtures/espn/settings-team.json";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5", NOW_OVERRIDE: "2026-08-15T12:00:00Z" };

// PPR and standard RB feeds disagree on purpose to prove format selection.
const TIER_FEEDS: Record<string, string> = {
  "RB-PPR": "Tier 1: Bo Rampart\nTier 2: Trey Ledger, Rio Deuce",
  RB: "Tier 1: Trey Ledger\nTier 2: Bo Rampart",
  "WR-PPR": "Tier 1: Sky Vandal\nTier 3: Ola Breeze",
  WR: "Tier 1: Sky Vandal",
  "TE-PPR": "Tier 1: Cliff Tower",
  TE: "Tier 1: Cliff Tower",
  QB: "Tier 1: Max Marshall\nTier 2: Jordan Quill",
  K: "Tier 1: Vic Uprights",
  DST: "Tier 1: Capital Guardians",
};

function standardLeague(id: number): object {
  const clone = structuredClone(ppr) as Record<string, any>;
  clone.id = id;
  clone.settings.name = "Standard League";
  clone.settings.scoringSettings.scoringItems.find((i: { statId: number }) => i.statId === 53)!.points = 0;
  return clone;
}

async function seed(stubTiers: Record<string, string | number | "network">, leagues: Record<string, object>) {
  const env = makeEnv(makeEspnStub(leagues as never, { kona, proTeams: proteams, tiers: stubTiers }), TEST_ENV);
  const cookie = await signInWithCreds(env, "tiers@b.co");
  const ids: Record<string, string> = {};
  for (const ref of Object.keys(leagues)) {
    ids[ref] = ((await (await api(env, cookie, "POST", "/api/leagues", { league_ref: ref })).json()) as { id: string }).id;
  }
  await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
  await ingestTiers(env, new Date("2026-08-15T09:00:00Z"));
  return { env, cookie, ids };
}

describe("board tiers (003)", () => {
  it("attaches format-correct tiers; QB/K/DST shared; unmatched → null", async () => {
    const { env, cookie, ids } = await seed(TIER_FEEDS, { "1001": ppr, "5005": standardLeague(5005) });

    const pprBoard = (await (await api(env, cookie, "GET", `/api/leagues/${ids["1001"]}/board`)).json()) as Record<string, any>;
    const by = (b: Record<string, any>, n: string) => b.players.find((p: { name: string }) => p.name === n);

    expect(by(pprBoard, "Bo Rampart").tier).toBe(1); // RB-PPR feed
    expect(by(pprBoard, "Trey Ledger").tier).toBe(2);
    expect(by(pprBoard, "Max Marshall").tier).toBe(1); // shared QB feed
    expect(by(pprBoard, "Vic Uprights").tier).toBe(1); // shared K feed
    expect(by(pprBoard, "Capital Guardians D/ST").tier).toBe(1); // DST nickname match
    expect(by(pprBoard, "Newt Longshot").tier).toBeNull(); // unprojected + unlisted

    const stdBoard = (await (await api(env, cookie, "GET", `/api/leagues/${ids["5005"]}/board`)).json()) as Record<string, any>;
    expect(by(stdBoard, "Bo Rampart").tier).toBe(2); // standard RB feed disagrees — format respected
    expect(by(stdBoard, "Trey Ledger").tier).toBe(1);
  });

  it("half-PPR falls back to the base feed when the -HALF variant is missing", async () => {
    const halfLeague = structuredClone(ppr) as Record<string, any>;
    halfLeague.id = 7007;
    halfLeague.settings.scoringSettings.scoringItems.find((i: { statId: number }) => i.statId === 53)!.points = 0.5;
    // No RB-HALF key in feeds → fallback to RB.
    const { env, cookie, ids } = await seed(TIER_FEEDS, { "7007": halfLeague });
    const board = (await (await api(env, cookie, "GET", `/api/leagues/${ids["7007"]}/board`)).json()) as Record<string, any>;
    const bo = board.players.find((p: { name: string }) => p.name === "Bo Rampart");
    expect(bo.tier).toBe(2); // base RB feed
  });

  it("a dead tier source leaves the board tierless but working (FR-002)", async () => {
    const dead: Record<string, "network"> = Object.fromEntries(
      Object.keys(TIER_FEEDS).map((k) => [k, "network" as const]),
    );
    const { env, cookie, ids } = await seed(dead, { "1001": ppr });
    const res = await api(env, cookie, "GET", `/api/leagues/${ids["1001"]}/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.players.length).toBeGreaterThan(0);
    expect(body.players.every((p: { tier: number | null }) => p.tier === null)).toBe(true);
  });

  it("the detail endpoint carries the tier too", async () => {
    const { env, cookie, ids } = await seed(TIER_FEEDS, { "1001": ppr });
    const res = await api(env, cookie, "GET", `/api/leagues/${ids["1001"]}/board/players/4429795`);
    const body = (await res.json()) as Record<string, any>;
    expect(body.player.tier).toBe(1);
  });
});
