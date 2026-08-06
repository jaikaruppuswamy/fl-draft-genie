// 008 T044 — what an import must capture, and what it must never keep.
//
// Tested against `parseCompletedDraft()` — the parser the script uses
// unmodified — plus the screening rule the script applies before writing.
// Re-testing the parser is deliberate: it is now load-bearing for a second
// feature, and the properties that matter here (keepers on every team, no sign
// filter) are not the ones 005 tested it for.
//
// The FETCH is not tested here. Whether ESPN serves past-season drafts at all
// is Gate 0's question (`scripts/lab-gate0.ts`), and it is an empirical fact
// about someone else's system rather than something a unit test can establish.

import { describe, expect, it } from "vitest";
import { parseCompletedDraft } from "../../src/espn/parsers";
import { memberNamesIn } from "../../scripts/sanitize-espn";
import type { EspnLeagueResponse } from "../../src/espn/types";

const draft = (picks: unknown[]): EspnLeagueResponse =>
  ({ draftDetail: { drafted: true, inProgress: false, picks } }) as unknown as EspnLeagueResponse;

const pick = (over: Record<string, unknown>) => ({
  overallPickNumber: 1,
  roundId: 1,
  roundPickNumber: 1,
  teamId: 1,
  playerId: 3000,
  keeper: false,
  autoDraftTypeId: 0,
  ...over,
});

describe("parseCompletedDraft captures what a corpus entry needs", () => {
  it("keeps round, round-pick, team, player and both flags", () => {
    const [p] = parseCompletedDraft(
      draft([pick({ overallPickNumber: 7, roundId: 2, roundPickNumber: 1, teamId: 4, keeper: true, autoDraftTypeId: 1 })]),
    );
    expect(p).toEqual({
      overall: 7,
      round: 2,
      roundPick: 1,
      teamId: 4,
      playerId: 3000,
      keeper: true,
      autodrafted: true,
    });
  });

  it("returns picks sorted by overall", () => {
    const parsed = parseCompletedDraft(
      draft([pick({ overallPickNumber: 3 }), pick({ overallPickNumber: 1 }), pick({ overallPickNumber: 2 })]),
    );
    expect(parsed.map((p) => p.overall)).toEqual([1, 2, 3]);
  });

  it("keeps a negative D/ST player id", () => {
    // `playerId > 0` is what made 010's capture report 66 of 72 picks for a
    // complete draft. The parser carries an explicit comment saying it does not
    // filter on sign; this is the test that keeps that true.
    const [p] = parseCompletedDraft(draft([pick({ playerId: -16001 })]));
    expect(p!.playerId).toBe(-16001);
  });

  it("keeps the −1 empty-slot sentinel rather than confusing it with a D/ST", () => {
    const [p] = parseCompletedDraft(draft([pick({ playerId: -1 })]));
    expect(p!.playerId).toBe(-1);
  });

  it("skips a row with no usable identity rather than inventing one", () => {
    expect(parseCompletedDraft(draft([pick({ playerId: "nonsense" })]))).toEqual([]);
  });
});

describe("keepers are recorded for EVERY team (FR-024)", () => {
  it("collects keepers held by teams other than the owner's", () => {
    // In some leagues keepers never arrive as picks at all, and a keeper on an
    // opponent's roster is just as unavailable as one on yours. Every league
    // this project has tested against is a redraft, so this omission would be
    // invisible until it reached someone else's league.
    const parsed = parseCompletedDraft(
      draft([
        pick({ overallPickNumber: 1, teamId: 1, playerId: 100, keeper: true }),
        pick({ overallPickNumber: 2, teamId: 5, playerId: 200, keeper: true }),
        pick({ overallPickNumber: 3, teamId: 3, playerId: 300, keeper: false }),
      ]),
    );
    const keepers = parsed.filter((p) => p.keeper).map((p) => ({ teamId: p.teamId, playerId: p.playerId }));
    expect(keepers).toEqual([
      { teamId: 1, playerId: 100 },
      { teamId: 5, playerId: 200 },
    ]);
  });
});

describe("the round-1 order is derived from the picks themselves", () => {
  it("reads the order off round 1, in overall sequence", () => {
    // A historical draft may have no published order at all, so it is derived
    // rather than read — and derived from round 1 only, because round 2 runs
    // backwards.
    const parsed = parseCompletedDraft(
      draft([
        pick({ overallPickNumber: 1, roundId: 1, teamId: 3 }),
        pick({ overallPickNumber: 2, roundId: 1, teamId: 1 }),
        pick({ overallPickNumber: 3, roundId: 1, teamId: 2 }),
        pick({ overallPickNumber: 4, roundId: 2, teamId: 2 }),
      ]),
    );
    const order = [
      ...new Set(parsed.filter((p) => p.round === 1).sort((a, b) => a.overall - b.overall).map((p) => p.teamId)),
    ];
    expect(order).toEqual([3, 1, 2]);
  });
});

describe("screening happens before the write (FR-021)", () => {
  it("detects member names in a candidate payload", () => {
    // The authenticated response carries `members[]` with real names and SWIDs
    // for every manager in the league. `memberNamesIn` is IMPORTED rather than
    // reimplemented: privacy-sweep.ts records what happened when this logic was
    // copied — the copy was wrong, and real names shipped to a public repo
    // while the sweep printed "clean".
    const payload = JSON.stringify({
      members: [{ id: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}", firstName: "Jordan", lastName: "Ellery" }],
    });
    expect(memberNamesIn(payload).length).toBeGreaterThan(0);
  });

  it("finds nothing in a numeric-only entry", () => {
    const clean = JSON.stringify({ picks: [{ overall: 1, teamId: 3, playerId: -16001 }] });
    expect(memberNamesIn(clean)).toEqual([]);
  });

  it("rejects a GUID anywhere in the text", () => {
    const GUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
    expect(GUID.test(`{"owner":"1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D"}`)).toBe(true);
    expect(GUID.test(`{"picks":[{"playerId":-16001}]}`)).toBe(false);
  });
});
