import { describe, expect, it } from "vitest";
import { currentSeason, parseLeagueRef } from "../../src/espn/leagueRef";

describe("league ref parsing (FR-010)", () => {
  it("accepts a bare numeric id", () => {
    expect(parseLeagueRef(" 123456 ")).toEqual({ leagueId: "123456" });
  });

  it("extracts id and season from ESPN URLs", () => {
    expect(
      parseLeagueRef("https://fantasy.espn.com/football/league?leagueId=123456&seasonId=2026"),
    ).toEqual({ leagueId: "123456", season: 2026 });
    expect(
      parseLeagueRef("https://fantasy.espn.com/football/league/settings?leagueId=99&foo=bar"),
    ).toEqual({ leagueId: "99", season: undefined });
  });

  it("rejects non-ESPN URLs and junk", () => {
    expect(parseLeagueRef("https://evil.example.com/?leagueId=1")).toBeNull();
    expect(parseLeagueRef("not a ref")).toBeNull();
    expect(parseLeagueRef("https://fantasy.espn.com/football/league")).toBeNull();
  });

  it("computes the fantasy season with a Jan–Mar rollback", () => {
    expect(currentSeason(new Date("2026-08-02T00:00:00Z"))).toBe(2026);
    expect(currentSeason(new Date("2027-01-15T00:00:00Z"))).toBe(2026);
    expect(currentSeason(new Date("2027-04-15T00:00:00Z"))).toBe(2027);
  });
});
