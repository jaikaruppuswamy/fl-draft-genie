// US2: five concurrent leagues under one account (FR-011 "at least 5"),
// distinct settings with zero bleed-through, isolated removal.

import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import ppr from "../fixtures/espn/settings-team.json";
import half from "../fixtures/espn/settings-team-half.json";

function variant(id: number, name: string, receptionPoints: number): object {
  const clone = structuredClone(ppr) as Record<string, any>;
  clone.id = id;
  clone.settings.name = name;
  clone.settings.scoringSettings.scoringItems.find((i: { statId: number }) => i.statId === 53)!.points =
    receptionPoints;
  return clone;
}

describe("US2: manage multiple leagues", () => {
  it("connects five leagues with distinct settings, then removes one cleanly", async () => {
    const env = makeEnv(
      makeEspnStub({
        "1001": ppr,
        "2002": half,
        "5005": variant(5005, "League Five", 0),
        "6006": variant(6006, "League Six", 2),
        "7007": variant(7007, "League Seven", 1),
      }),
    );
    const cookie = await signInWithCreds(env, "multi@b.co");

    const ids: Record<string, string> = {};
    for (const ref of ["1001", "2002", "5005", "6006", "7007"]) {
      const res = await api(env, cookie, "POST", "/api/leagues", { league_ref: ref });
      expect(res.status).toBe(201);
      ids[ref] = ((await res.json()) as { id: string }).id;
    }

    const list = (await (await api(env, cookie, "GET", "/api/leagues")).json()) as {
      leagues: { name: string; scoring_summary: string }[];
    };
    expect(list.leagues).toHaveLength(5);
    const byName = Object.fromEntries(list.leagues.map((l) => [l.name, l.scoring_summary]));
    // No bleed-through: each league keeps its own scoring identity.
    expect(byName["Gridiron Gurus"]).toBe("PPR · 16 slots");
    expect(byName["Naperville Nine"]).toBe("0.5 PPR · 16 slots");
    expect(byName["League Five"]).toBe("Standard · 16 slots");
    expect(byName["League Six"]).toBe("2 pt/rec · 16 slots");
    expect(byName["League Seven"]).toBe("PPR · 16 slots");

    expect((await api(env, cookie, "DELETE", `/api/leagues/${ids["6006"]}`)).status).toBe(204);
    const after = (await (await api(env, cookie, "GET", "/api/leagues")).json()) as { leagues: { name: string }[] };
    expect(after.leagues).toHaveLength(4);
    expect(after.leagues.map((l) => l.name)).not.toContain("League Six");
  });
});
