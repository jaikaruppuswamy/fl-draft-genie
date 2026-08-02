import { describe, expect, it } from "vitest";
import { maskSwid, normalizeEspnS2, normalizeSwid } from "../../src/auth/normalizeCookies";

const S2 = "AEB%2FlongOpaqueTokenValue1234567890abcdefghijklmnop%2Bmore";

describe("cookie normalization (FR-004)", () => {
  it("strips whitespace and wrapping quotes from espn_s2", () => {
    expect(normalizeEspnS2(`  "${S2}"  `)).toBe(S2);
    expect(normalizeEspnS2(`'${S2}'`)).toBe(S2);
  });

  it("rejects short or whitespace-y espn_s2 values", () => {
    expect(normalizeEspnS2("abc")).toBeNull();
    expect(normalizeEspnS2("has spaces inside the value which is wrong aaaaaaaaaa")).toBeNull();
  });

  it("fixes SWID braces, case, and quotes", () => {
    const want = "{ABCDEF12-1111-2222-3333-ABCDEF123456}";
    expect(normalizeSwid("abcdef12-1111-2222-3333-abcdef123456")).toBe(want);
    expect(normalizeSwid('"{abcdef12-1111-2222-3333-abcdef123456}"')).toBe(want);
    expect(normalizeSwid("  {ABCDEF12-1111-2222-3333-ABCDEF123456}  ")).toBe(want);
  });

  it("rejects non-GUID SWIDs", () => {
    expect(normalizeSwid("{not-a-guid}")).toBeNull();
    expect(normalizeSwid("")).toBeNull();
  });

  it("masks SWID to first/last four of the core", () => {
    expect(maskSwid("{ABCDEF12-1111-2222-3333-ABCDEF123456}")).toBe("{ABCD…3456}");
  });
});
