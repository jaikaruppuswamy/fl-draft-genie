// Foundational ingest flow (FR-017): fixture ingest yields a serving set;
// a failed refresh leaves the previous set serving; the sanity gate rejects
// tiny fetches.

import { describe, expect, it } from "vitest";
import { ingestProjections } from "../../src/projections/ingest";
import { getServingSet, getSetRows } from "../../src/db/projections";
import { makeEnv } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5" }; // fixture has 14 projected players

describe("projection ingest (all-or-nothing)", () => {
  it("ingests fixtures into a complete serving set", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    const result = await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
    expect(result.ok).toBe(true);
    const serving = await getServingSet(env.DB, 2026);
    expect(serving?.status).toBe("complete");
    expect(serving?.player_count).toBe(14); // 15 players minus 1 unprojected
    const rows = await getSetRows(env.DB, serving!.id);
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => JSON.parse(r.stats_json))).toBeTruthy();
  });

  it("a failed fetch leaves the previous serving set untouched", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const env = makeEnv(stub, TEST_ENV);
    const first = await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
    expect(first.ok).toBe(true);

    stub.kona = "network";
    const second = await ingestProjections(env, 2026, "on_demand", new Date("2026-08-16T09:00:00Z"));
    expect(second).toEqual({ ok: false, code: "source_unreachable" });

    const serving = await getServingSet(env.DB, 2026);
    expect(serving?.id).toBe((first as { setId: string }).setId);
  });

  it("rejects a suspiciously small fetch (sanity gate) without publishing", async () => {
    const tiny = { players: (kona as { players: unknown[] }).players.slice(0, 2) };
    const env = makeEnv(makeEspnStub({}, { kona: tiny, proTeams: proteams }), TEST_ENV);
    const result = await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
    expect(result).toEqual({ ok: false, code: "source_invalid" });
    expect(await getServingSet(env.DB, 2026)).toBeNull();
  });
});
