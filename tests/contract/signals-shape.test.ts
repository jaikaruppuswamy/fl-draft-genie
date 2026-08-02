// 004 US3: every signal kind reads through one uniform, kind-agnostic shape
// with populated provenance (FR-005/FR-006).

import { describe, expect, it } from "vitest";
import { makeEnv } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { ingestProjections } from "../../src/projections/ingest";
import { computeSignals } from "../../src/signals/compute";
import { getSignalMaps, replaceSignalKind } from "../../src/db/signals";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";
import olineFixture from "../fixtures/signals/oline-valid.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5" };
const FIELDS = ["raw_value", "score", "rank", "provenance", "computed_at"].sort();

describe("uniform signal shape (US3)", () => {
  it("all kinds expose identical fields with correct provenance formats", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    await ingestProjections(env, 2026, "scheduled", new Date("2026-08-15T09:00:00Z"));
    await computeSignals(env, new Date("2026-08-15T09:05:00Z"), { curatedOline: olineFixture });

    const maps = await getSignalMaps(env.DB);
    expect([...maps.keys()].sort()).toEqual(["offense", "oline", "sos"]);
    for (const [kind, teamMap] of maps) {
      expect(teamMap.size).toBeGreaterThan(0);
      for (const value of teamMap.values()) {
        expect(Object.keys(value).sort()).toEqual(FIELDS);
        expect(value.rank).toBeGreaterThanOrEqual(1);
        expect(value.score).toBeGreaterThanOrEqual(0);
        expect(value.score).toBeLessThanOrEqual(100);
        if (kind === "oline") expect(value.provenance).toMatch(/^curated:/);
        else expect(value.provenance).toMatch(/^derived:projections@/);
      }
    }
  });

  it("the reader is kind-agnostic: a new kind row needs no read-path change", async () => {
    const env = makeEnv();
    // Simulate a future signal kind by writing under an existing CHECK value
    // via the same generic writer the real kinds use — the reader must not
    // special-case kinds.
    await replaceSignalKind(env.DB, "offense", [
      { pro_team_id: 42, raw_value: 1.5, score: 77, rank: 4, provenance: "derived:test@x", computed_at: "2026-08-15T00:00:00Z" },
    ]);
    const maps = await getSignalMaps(env.DB);
    expect(maps.get("offense")!.get(42)).toMatchObject({ rank: 4, score: 77 });
  });
});
