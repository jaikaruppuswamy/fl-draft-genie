// 004 US2: signals recompute in lockstep with projection refreshes (SC-004),
// keep last-good on failure, and handle the fresh-deploy case.

import { describe, expect, it } from "vitest";
import { makeEnv } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import { runScheduledMaintenance } from "../../src/sync/predraft";
import { getSignalMaps } from "../../src/db/signals";
import { getServingSet } from "../../src/db/projections";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5" };
const AUG = (s: string) => new Date(`2026-08-${s}`);

describe("signal freshness (US2)", () => {
  it("derived kinds' computed_at equals the serving set's fetched_at (SC-004)", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    await ingestProjections(env, 2026, "scheduled", AUG("14T09:00:00Z"));
    await runScheduledMaintenance(env, AUG("14T09:05:00Z")); // computes signals (empty table)

    const serving = await getServingSet(env.DB, 2026);
    const maps = await getSignalMaps(env.DB);
    expect(maps.get("offense")!.get(2)!.computed_at).toBe(serving!.fetched_at);
    expect(maps.get("sos")!.get(1)!.computed_at).toBe(serving!.fetched_at);

    // A later projection refresh (25h → stale) advances signals in lockstep.
    await runScheduledMaintenance(env, AUG("15T10:00:00Z"));
    const serving2 = await getServingSet(env.DB, 2026);
    expect(serving2!.fetched_at).not.toBe(serving!.fetched_at);
    const maps2 = await getSignalMaps(env.DB);
    expect(maps2.get("offense")!.get(2)!.computed_at).toBe(serving2!.fetched_at);
  });

  it("a failed projection refresh leaves signals untouched", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const env = makeEnv(stub, TEST_ENV);
    await ingestProjections(env, 2026, "scheduled", AUG("14T09:00:00Z"));
    await runScheduledMaintenance(env, AUG("14T09:05:00Z"));
    const before = (await getSignalMaps(env.DB)).get("offense")!.get(2)!;

    stub.kona = "network"; // projections can't refresh at the stale tick
    await runScheduledMaintenance(env, AUG("15T10:00:00Z"));
    const after = (await getSignalMaps(env.DB)).get("offense")!.get(2)!;
    expect(after.computed_at).toBe(before.computed_at);
  });

  it("empty table with no serving projection set → curated oline only, derived skipped", async () => {
    const env = makeEnv(makeEspnStub({}, { kona: "network", proTeams: proteams }), TEST_ENV);
    await runScheduledMaintenance(env, AUG("14T09:05:00Z"));
    const maps = await getSignalMaps(env.DB);
    expect(maps.get("offense")).toBeUndefined();
    expect(maps.get("sos")).toBeUndefined();
    expect(maps.get("oline")!.size).toBeGreaterThan(0); // bundled seed file loads
  });
});
