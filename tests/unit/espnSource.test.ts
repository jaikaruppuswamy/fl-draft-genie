import { describe, expect, it } from "vitest";
import { fetchPlayers, fetchProTeams } from "../../src/projections/espnSource";
import { makeEnv } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

describe("ESPN projection source (public endpoints)", () => {
  it("parses the kona_player_info fixture into typed records", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const players = await fetchPlayers(makeEnv(stub), 2026);
    expect(players).toHaveLength(13);

    const rb = players.find((p) => p.fullName === "Bo Rampart")!;
    expect(rb.primaryPosition).toBe("RB");
    expect(rb.eligiblePositions).toEqual(["RB", "FLEX"]);
    expect(rb.statLine!["24"]).toBe(1250.0);
    expect(rb.adp).toBe(2.3);
    expect(rb.overallRank).toBe(2);

    const multi = players.find((p) => p.fullName === "Rio Deuce")!;
    expect(multi.eligiblePositions).toEqual(expect.arrayContaining(["RB", "WR", "FLEX"]));

    const rookie = players.find((p) => p.fullName === "Newt Longshot")!;
    expect(rookie.statLine).toBeNull();
    expect(rookie.adp).toBeNull();

    const inactive = players.find((p) => p.fullName === "Gus Hasbeen")!;
    expect(inactive.active).toBe(false);

    const dst = players.find((p) => p.fullName === "Capital Guardians D/ST")!;
    expect(dst.espnPlayerId).toBe(-16007);
    expect(dst.primaryPosition).toBe("DST");
  });

  it("parses pro teams with bye weeks", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const teams = await fetchProTeams(makeEnv(stub), 2026);
    expect(teams.find((t) => t.abbrev === "BUF")?.byeWeek).toBe(7);
    expect(teams.find((t) => t.abbrev === "FA")?.byeWeek).toBeNull();
  });

  it("never sends a Cookie header (public endpoints, no user context)", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const env = makeEnv(stub);
    await fetchPlayers(env, 2026);
    await fetchProTeams(env, 2026);
    for (const req of stub.requests) {
      expect(req.cookie).toBe("");
    }
  });

  it("maps failures to espn_unreachable", async () => {
    const stub = makeEspnStub({}, { kona: "network", proTeams: proteams });
    await expect(fetchPlayers(makeEnv(stub), 2026)).rejects.toMatchObject({ code: "espn_unreachable" });
    const stub500 = makeEspnStub({}, { kona: 500 });
    await expect(fetchPlayers(makeEnv(stub500), 2026)).rejects.toMatchObject({ code: "espn_unreachable" });
  });
});
