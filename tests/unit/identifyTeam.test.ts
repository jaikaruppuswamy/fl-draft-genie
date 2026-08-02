import { describe, expect, it } from "vitest";
import { identifyMyTeam } from "../../src/espn/identifyTeam";
import type { EspnLeagueResponse } from "../../src/espn/types";
import ppr from "../fixtures/espn/settings-team.json";
import odd from "../fixtures/espn/settings-odd.json";

const MY_SWID = "{11111111-2222-3333-4444-555555555555}";

describe("team auto-match (FR-014)", () => {
  it("finds the team owned by the SWID", () => {
    expect(identifyMyTeam(ppr as EspnLeagueResponse, MY_SWID)).toBe(4);
  });

  it("matches case-insensitively", () => {
    expect(identifyMyTeam(ppr as EspnLeagueResponse, MY_SWID.toLowerCase())).toBe(4);
  });

  it("returns null when the SWID owns no team", () => {
    expect(identifyMyTeam(odd as EspnLeagueResponse, MY_SWID)).toBeNull();
  });
});
