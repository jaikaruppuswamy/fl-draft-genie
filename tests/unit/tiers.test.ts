import { describe, expect, it } from "vitest";
import { normalizeName, parseTierText, tierFormatForLeague } from "../../src/tiers/borischen";

describe("tier text parsing (Boris Chen format)", () => {
  it("parses 'Tier N: name, name' lines", () => {
    const text = "Tier 1: Christian McCaffrey, Jahmyr Gibbs\nTier 2: De'Von Achane, James Cook III\nnoise line\n";
    const entries = parseTierText(text, "RB");
    expect(entries).toEqual([
      { name_norm: "christian mccaffrey", tier: 1 },
      { name_norm: "jahmyr gibbs", tier: 1 },
      { name_norm: "devon achane", tier: 2 },
      { name_norm: "james cook", tier: 2 },
    ]);
  });

  it("returns empty on format drift (fail-safe)", () => {
    expect(parseTierText("<html>error</html>", "RB")).toEqual([]);
  });
});

describe("name normalization (FR-003)", () => {
  it("strips suffixes, punctuation, and diacritics", () => {
    expect(normalizeName("Travis Etienne Jr.", "RB")).toBe("travis etienne");
    expect(normalizeName("Amon-Ra St. Brown", "WR")).toBe("amonra st brown");
    expect(normalizeName("Kenneth Walker III", "RB")).toBe("kenneth walker");
  });

  it("reduces D/ST names to the team nickname on both sides", () => {
    expect(normalizeName("Denver Broncos", "DST")).toBe("broncos");
    expect(normalizeName("Broncos D/ST", "DST")).toBe("broncos");
    expect(normalizeName("Capital Guardians D/ST", "DST")).toBe("guardians");
  });
});

describe("league format mapping (FR-004)", () => {
  it("maps reception value to tier format", () => {
    expect(tierFormatForLeague(1)).toBe("ppr");
    expect(tierFormatForLeague(0.75)).toBe("ppr");
    expect(tierFormatForLeague(0.5)).toBe("half");
    expect(tierFormatForLeague(0.25)).toBe("half");
    expect(tierFormatForLeague(0)).toBe("std");
    expect(tierFormatForLeague(null)).toBe("std");
    expect(tierFormatForLeague(2)).toBe("ppr");
  });
});
