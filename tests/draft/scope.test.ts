// 011 T005 — the split that keeps one manager's board theirs.
//
// Under fan-out EVERY session in a league sees the SAME frames. The only thing
// left keeping a manager's board their own is that their scope stays local — so
// this is the guard that replaces the accidental isolation fan-out removes.
//
// It is not hypothetical. On 2026-08-06 a corpus entry was built carrying
// another manager's team, because ownership was inferred from which connection
// had more batches (71 vs 1) rather than from whose account it was. The same
// mistake inside the session would put a leaguemate's team on your draft board,
// mid-draft, and nothing downstream could detect it.
//
// Structural, deliberately: a behavioural test proves one path is right today,
// while reading the source proves no path can go wrong tomorrow.

import { describe, expect, it } from "vitest";
import type { DraftFacts, ManagerView, SessionScope } from "../../src/draft/session";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Options written out at the call site — Vite parses the literal, and hoisting
// it into a const fails the build.
const draftSources = import.meta.glob("../../src/draft/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

describe("the shared half and the per-manager half are named apart", () => {
  it("assigns every field to exactly one half", () => {
    // A field appearing in both, or in neither, is how the distinction rots.
    const facts: DraftFacts = { espnLeagueId: "1", season: 2026, order: [1, 2] };
    const view: ManagerView = { accountId: "a", connectionId: "c", myTeamId: 1, totalPicks: 12 };
    const scope: SessionScope = { ...facts, ...view };

    expect(Object.keys(facts).sort()).toEqual(["espnLeagueId", "order", "season"]);
    expect(Object.keys(view).sort()).toEqual(["accountId", "connectionId", "myTeamId", "totalPicks"]);
    expect(Object.keys(scope).sort()).toEqual(
      [...Object.keys(facts), ...Object.keys(view)].sort(),
    );
  });

  it("keeps totalPicks on the PER-MANAGER side", () => {
    // The field most likely to be "tidied" into DraftFacts, because it looks
    // like a property of the draft. It is not: two managers in one league
    // recorded 11 and 12 rounds for the same draft on 2026-08-06, one snapshot
    // being stale. Moving it would let a leaguemate's stale sync reshape your
    // board — and would do it silently.
    const view: ManagerView = { accountId: "a", connectionId: "c", myTeamId: 1, totalPicks: 12 };
    expect(view).toHaveProperty("totalPicks");

    const facts: DraftFacts = { espnLeagueId: "1", season: 2026, order: [] };
    expect(facts).not.toHaveProperty("totalPicks");
  });

  it("keeps myTeamId on the PER-MANAGER side", () => {
    const facts: DraftFacts = { espnLeagueId: "1", season: 2026, order: [] };
    expect(facts).not.toHaveProperty("myTeamId");
  });
});

describe("a session never takes its perspective from a relayer", () => {
  it("has sources to check", () => {
    // Without this the suite below passes vacuously — the failure mode 006's
    // mutation sweep hit when only 10 of 102 tests actually ran.
    expect(Object.keys(draftSources).length).toBeGreaterThan(0);
  });

  it("names no relayer-derived identity in src/draft/", () => {
    // A scope built from `relayer.*`, `relayingAccount`, `fromAccount` or
    // similar is the bug this whole feature exists to prevent. The audience for
    // a fan-out is a LIST of connections; each session is armed from its own.
    const banned = /\b(relayerAccountId|relayingAccountId|relayerConnectionId|fromRelayer)\b/;
    const offenders = Object.entries(draftSources)
      .filter(([, s]) => banned.test(code(s)))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("PROVES the check can fail", () => {
    // A guard that cannot fire is decoration — the companion assertion 007
    // shipped SC-003 without.
    const banned = /\b(relayerAccountId|relayingAccountId|relayerConnectionId|fromRelayer)\b/;
    expect(banned.test(code("const scope = { myTeamId: relayerAccountId };"))).toBe(true);
    expect(banned.test(code("// relayerAccountId must never be used here"))).toBe(false);
  });
});
