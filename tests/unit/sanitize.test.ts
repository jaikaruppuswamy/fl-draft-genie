// The sanitizer is the control that keeps real SWIDs out of the repo
// (005 T001, constitution: Security & Privacy). It is trusted by every Gate 0
// capture, so it is tested before it is relied on.

import { describe, expect, it } from "vitest";
import {
  deriveMapping,
  sanitize,
  assertClean,
  mergeMapping,
  GUID_RE,
  MY_SWID,
} from "../../scripts/sanitize-espn";

const REAL_A = "{9F2A1C7E-4B3D-4E8A-9C1F-2D6B8E0A5C31}";
const REAL_B = "{1A2B3C4D-5E6F-4A8B-9C0D-1E2F3A4B5C6D}";
const REAL_C = "{7777AAAA-8888-4BBB-9CCC-DDDDEEEEFFFF}";

const league = () => ({
  id: 111,
  seasonId: 2026,
  settings: { name: "DraftGenieTester", size: 6 },
  members: [
    { id: REAL_A, displayName: "jkaruppuswamy", firstName: "Jai", lastName: "Karuppuswamy" },
    { id: REAL_B, displayName: "sam99", firstName: "Sam", lastName: "Ng" },
    { id: REAL_C, displayName: "spectator", firstName: "Pat", lastName: "Lee" },
  ],
  teams: [
    { id: 3, name: "Sam's Squad", abbrev: "SAM", owners: [REAL_B] },
    { id: 7, name: "Jai's Juggernauts", abbrev: "JAI", owners: [REAL_A] },
  ],
  draftDetail: { drafted: false, inProgress: true, picks: [] },
});

const clean = (myTeamId = 7) => {
  const src = league();
  const m = deriveMapping(src, myTeamId);
  const out = sanitize(src, m);
  return { m, out, json: JSON.stringify(out) };
};

describe("deriveMapping / sanitize", () => {
  it("maps the owner of my team to the suite's fixed identity", () => {
    const { json } = clean(7);
    expect(json).toContain(MY_SWID.replace(/[{}]/g, ""));
  });

  it("indexes teams by ascending ESPN teamId, not array order", () => {
    // team 3 sorts first ⇒ index 1, team 7 ⇒ index 2 (and is "mine").
    const { out } = clean(7);
    expect(out.teams[0]!.name).toBe("Team 1");
    expect(out.teams[1]!.name).toBe("Team 2");
    expect(out.teams[0]!.abbrev).toBe("T1");
  });

  it("removes every real GUID, display name and surname", () => {
    const { json } = clean();
    for (const secret of [REAL_A, REAL_B, REAL_C, "jkaruppuswamy", "Karuppuswamy", "sam99", "DraftGenieTester"]) {
      expect(json).not.toContain(secret.replace(/[{}]/g, ""));
    }
  });

  it("scrubs GUIDs in fields the derivation does not model", () => {
    const src = { ...league(), someUndocumentedField: { primaryOwner: REAL_C, note: `owner ${REAL_C}` } };
    const m = deriveMapping(src, 7);
    const out = sanitize(src, m) as typeof src;
    expect(JSON.stringify(out)).not.toContain(REAL_C.replace(/[{}]/g, ""));
    // still GUID-shaped, so downstream parsing is unaffected
    expect(out.someUndocumentedField.primaryOwner).toMatch(GUID_RE);
  });

  it("is deterministic — same input, same mapping, no persisted table", () => {
    expect(JSON.stringify(clean().out)).toBe(JSON.stringify(clean().out));
  });

  it("replaces longer names before their substrings", () => {
    const src = league();
    src.members[0]!.displayName = "Jai the Great";
    const m = deriveMapping(src, 7);
    const json = JSON.stringify(sanitize(src, m));
    expect(json).not.toContain("Jai the Great");
    expect(json).not.toContain("Karuppuswamy");
  });

  it("does not corrupt player data that merely shares a manager's first name", () => {
    // A manager called "Sam" must not turn "Sam Darnold" into "Manager Darnold";
    // short identity values are replaced on their own fields only.
    const src = {
      ...league(),
      players: [{ fullName: "Sam Darnold" }, { fullName: "Jai Fakename" }],
      proTeams: [{ abbrev: "SAM" }],
    };
    const m = deriveMapping(src, 7);
    const out = sanitize(src, m) as typeof src;
    expect(out.players[0]!.fullName).toBe("Sam Darnold");
    expect(out.proTeams[0]!.abbrev).toBe("SAM");
    // ...while the member's own fields are still scrubbed.
    expect(out.members[1]!.firstName).toBe("Manager");
    expect(out.members[1]!.lastName).toBe("1");
  });

  it("still removes a full real name found in an unmodelled field", () => {
    const src = { ...league(), note: "drafted by Jai Karuppuswamy" };
    const m = deriveMapping(src, 7);
    const out = sanitize(src, m) as typeof src;
    expect(out.note).not.toContain("Karuppuswamy");
  });

  it("keeps a multi-team owner on one stable placeholder", () => {
    const src = league();
    src.teams.push({ id: 9, name: "Second Squad", abbrev: "SS2", owners: [REAL_B] });
    const m = deriveMapping(src, 7);
    // REAL_B owns teams 3 (index 1) and 9 (index 3) ⇒ lowest wins.
    expect(m.guid.get(REAL_B.replace(/[{}]/g, ""))).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("assertClean", () => {
  it("passes a sanitized document", () => {
    const { out, m } = clean();
    expect(() => assertClean(out, m, ["s2-cookie-value", "swid-value"])).not.toThrow();
  });

  it("throws when a real GUID survives", () => {
    const { m } = clean();
    expect(() => assertClean({ leaked: REAL_A }, m)).toThrow(/Sanitization check failed/);
  });

  it("throws when a credential value is present", () => {
    const { out, m } = clean();
    expect(() => assertClean({ ...out, cookie: "AEBsecret" }, m, ["AEBsecret"])).toThrow(/credential value/);
  });

  it("throws on an unmapped GUID even if it was never in the mapping", () => {
    const { out, m } = clean();
    expect(() => assertClean({ ...out, stray: "{DEADBEEF-0000-4000-8000-000000000000}" }, m)).toThrow(
      /unmapped GUID/,
    );
  });

  it("does not echo the offending value in its message", () => {
    const { m } = clean();
    try {
      assertClean({ leaked: REAL_A }, m);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(REAL_A.replace(/[{}]/g, ""));
    }
  });
});

describe("mergeMapping", () => {
  it("keeps the first mapping's placeholders when merging a later capture", () => {
    const a = deriveMapping(league(), 7);
    const later = league();
    later.teams.push({ id: 1, name: "Late Joiner", abbrev: "LJ", owners: [REAL_C] });
    const merged = mergeMapping(a, deriveMapping(later, 7));
    expect(merged.guid.get(REAL_A.replace(/[{}]/g, ""))).toBe(a.guid.get(REAL_A.replace(/[{}]/g, "")));
    expect(merged.guid.has(REAL_C.replace(/[{}]/g, ""))).toBe(true);
  });
});

// --- tap-frame sanitization (010 T008) -------------------------------------
// The Gate 0 capture established that SELECTED carries a member SWID in an
// optional 4th field — so every human pick frame is a potential leak. This is
// the control that keeps them out of the repo.

describe("tap capture sanitization", () => {
  // Fabricated, NOT from any capture — a real SWID must never enter the repo,
  // which is the rule this very suite exists to enforce.
  const OWNER = "{AAAAAAAA-1111-4111-8111-111111111111}";
  const OTHER = "{BBBBBBBB-2222-4222-8222-222222222222}";
  const LEAGUE = "9999999999";
  const frames = () => [
    { transport: "ws", event: "message", enc: "text", data: `TOKEN 1:${LEAGUE}:2:${OWNER}:1053670275\n` },
    { transport: "ws", event: "message", enc: "text", data: `JOINED 2 ${OWNER}\n` },
    { transport: "ws", event: "message", enc: "text", data: `JOINED 5 ${OTHER}\n` },
    { transport: "ws", event: "message", enc: "text", data: `SELECTED 5 4429795 2 ${OTHER}\n` },
    { transport: "ws", event: "message", enc: "text", data: "SELECTED 5 -16007 7\n" },
    { transport: "ws", event: "construct", url: `wss://fantasydraft.espn.com/game-1/league-${LEAGUE}/JOIN?4=${OWNER}` },
  ];

  it("maps the capturing owner's SWID to the suite identity", async () => {
    const { deriveTapMapping } = await import("../../scripts/sanitize-espn");
    const m = deriveTapMapping(frames());
    expect(m.guid.get(OWNER.replace(/[{}]/g, ""))).toBe(MY_SWID.replace(/[{}]/g, ""));
  });

  it("strips the SWID from SELECTED's optional 4th field", async () => {
    const { deriveTapMapping, sanitizeTapFrame } = await import("../../scripts/sanitize-espn");
    const f = frames();
    const m = deriveTapMapping(f);
    const out = f.map((x) => sanitizeTapFrame(x, m));
    const json = JSON.stringify(out);
    expect(json).not.toContain(OTHER.replace(/[{}]/g, ""));
    expect(json).not.toContain(OWNER.replace(/[{}]/g, ""));
    // structure preserved so the frame still parses
    expect(out[3]!.data).toMatch(/^SELECTED 5 4429795 2 \{[0-9a-f-]+\}\n$/i);
  });

  it("preserves negative player ids (D/ST)", async () => {
    const { deriveTapMapping, sanitizeTapFrame } = await import("../../scripts/sanitize-espn");
    const f = frames();
    const out = sanitizeTapFrame(f[4]!, deriveTapMapping(f));
    expect(out.data).toBe("SELECTED 5 -16007 7\n");
  });

  it("replaces the league id even when percent-encoded inside a nested URL", async () => {
    // Regression: a \b-anchored rule missed `%3D<leagueId>%26` because the `D`
    // from `%3D` destroys the left word boundary. Caught by assertTapClean.
    const { deriveTapMapping, sanitizeTapFrame } = await import("../../scripts/sanitize-espn");
    const f = frames();
    f.push({ transport: "fetch", event: "chunk", enc: "text", data: `redirect%3Fleague%3D${LEAGUE}%26x%3D1` });
    const m = deriveTapMapping(f);
    expect(JSON.stringify(f.map((x) => sanitizeTapFrame(x, m)))).not.toContain(LEAGUE);
  });

  it("assertTapClean throws when a real SWID survives", async () => {
    const { deriveTapMapping, assertTapClean } = await import("../../scripts/sanitize-espn");
    const m = deriveTapMapping(frames());
    expect(() => assertTapClean([{ data: `SELECTED 1 2 3 ${OTHER}` }], m)).toThrow(/Tap sanitization failed/);
  });

  it("scrubs GUIDs it does not recognise rather than passing them through", async () => {
    const { deriveTapMapping, sanitizeTapFrame, assertTapClean } = await import("../../scripts/sanitize-espn");
    const f = frames();
    const m = deriveTapMapping(f);
    const stray = { transport: "ws", event: "message", enc: "text", data: '{"id":"DEADBEEF-1111-4222-8333-444455556666"}' };
    const out = sanitizeTapFrame(stray, m, new Map());
    expect(JSON.stringify(out)).not.toContain("DEADBEEF");
    expect(() => assertTapClean([out], m)).not.toThrow();
  });
});
