// Cadence policy + scheduled maintenance (FR-015/FR-018, SC-004/SC-007),
// driven with fake clocks.

import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { isStale } from "../../src/projections/freshness";
import { ingestProjections } from "../../src/projections/ingest";
import { runScheduledMaintenance } from "../../src/sync/predraft";
import { getNewestSet, getServingSet } from "../../src/db/projections";
import { iso, uuid } from "../../src/db/client";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";
import ppr from "../fixtures/espn/settings-team.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5" };
const AUG = (s: string) => new Date(`2026-08-${s}`);

describe("isStale cadence policy", () => {
  it("draft season (Aug–Sep): stale after 24h", () => {
    expect(isStale("2026-08-14T09:00:00Z", AUG("15T08:00:00Z"))).toBe(false); // 23 h
    expect(isStale("2026-08-14T09:00:00Z", AUG("15T10:00:00Z"))).toBe(true); // 25 h
  });
  it("off-season: stale after 7 days", () => {
    expect(isStale("2026-10-01T09:00:00Z", new Date("2026-10-04T09:00:00Z"))).toBe(false); // 3 d
    expect(isStale("2026-10-01T09:00:00Z", new Date("2026-10-09T10:00:00Z"))).toBe(true); // 8 d
  });
  it("no serving set is always stale", () => {
    expect(isStale(null, AUG("15T10:00:00Z"))).toBe(true);
  });
});

describe("scheduled maintenance", () => {
  it("refreshes when the serving set ages past the cadence", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    await ingestProjections(env, 2026, "scheduled", AUG("14T09:00:00Z"));

    // 23h later: nothing happens.
    await runScheduledMaintenance(env, AUG("15T08:00:00Z"));
    expect((await getServingSet(env.DB, 2026))?.fetched_at).toBe("2026-08-14T09:00:00.000Z");

    // 25h later: a scheduled refresh fires.
    await runScheduledMaintenance(env, AUG("15T10:00:00Z"));
    const serving = await getServingSet(env.DB, 2026);
    expect(serving?.fetched_at).toBe("2026-08-15T10:00:00.000Z");
    expect(serving?.trigger_kind).toBe("scheduled");
  });

  it("draft-day top-up: a league entering its pre-draft window forces a refresh (SC-007)", async () => {
    // League fixture draft time: 1788486000000 = 2026-09-03T07:00:00.000Z
    const draftAt = new Date(1788486000000);
    const stub = makeEspnStub({ "1001": ppr }, { kona, proTeams: proteams });
    const env = makeEnv(stub, TEST_ENV);
    const cookie = await signInWithCreds(env, "topup@b.co");
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });

    // Serving set fetched the prior evening — fresh by cadence (< 24 h), but
    // it predates the pre-draft window opening.
    await ingestProjections(env, 2026, "scheduled", new Date(draftAt.getTime() - 10 * 3600_000));

    const tick = new Date(draftAt.getTime() - 70 * 60_000); // inside the 75-min window
    await runScheduledMaintenance(env, tick);
    const serving = await getServingSet(env.DB, 2026);
    expect(serving?.trigger_kind).toBe("draft_day");
    expect(serving?.fetched_at).toBe(tick.toISOString());

    // Next tick: serving set now postdates the window → no second top-up.
    const tick2 = new Date(draftAt.getTime() - 65 * 60_000);
    await runScheduledMaintenance(env, tick2);
    expect((await getServingSet(env.DB, 2026))?.fetched_at).toBe(tick.toISOString());
  });

  it("prunes prior-season sets", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    await env.DB.prepare(
      "INSERT INTO projection_sets (id, season, source, status, trigger_kind, fetched_at, player_count) VALUES (?, 2025, 'espn', 'complete', 'scheduled', ?, 900)",
    )
      .bind(uuid(), iso(new Date("2025-09-01T00:00:00Z")))
      .run();
    await ingestProjections(env, 2026, "scheduled", AUG("15T09:00:00Z"));
    await runScheduledMaintenance(env, AUG("15T10:30:00Z"));
    const old = await getNewestSet(env.DB, 2025);
    expect(old).toBeNull();
  });
});
