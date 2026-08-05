// 007 T003 / T047 — the structural guard.
//
// Two properties, both of which decay silently if only a comment defends them:
//
//   FR-010/FR-024  the reducer is pure — no clock, no I/O, no DOM, no React.
//                  This is not style. It is the ONLY reason SC-001 can be
//                  measured offline at all; the moment `draftRoom.ts` reads a
//                  clock, the replay harness stops being possible and this
//                  feature needs a test stack the project does not have.
//
//   FR-020         the draft room issues no non-GET request. Constitution VI is
//                  absolute — Draft Genie observes and advises, never acts — and
//                  "the code happens not to contain a write today" is a
//                  coincidence waiting for a convenience helper, not a property.
//
// Runs in the node project, so real `fs` is available (unlike 006's equivalent,
// which had to reach for `import.meta.glob`).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

const REDUCER_FILES = ["web/src/lib/draftRoom.ts", "web/src/lib/draftRoomSelectors.ts"];

/** Everything the draft room renders or decides with. */
const ROOM_FILES = [
  ...REDUCER_FILES,
  "web/src/pages/DraftRoom.tsx",
  "web/src/components/RecommendationPanel.tsx",
];

/**
 * Strip comments and string literals before scanning.
 *
 * Without this the guard fires on its own documentation — `draftRoom.ts`
 * explains at length why it may not touch a clock, and the word `Date` appears
 * in that explanation. A guard that cannot survive being commented is a guard
 * someone will delete.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function read(rel: string): string | null {
  const path = join(ROOT, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("the reducer is pure (FR-010, and therefore FR-024)", () => {
  it("has files to check — a guard over an empty set proves nothing", () => {
    // The failure this prevents: a path drifts, the guard matches nothing, and
    // every assertion below passes vacuously forever. 005 shipped exactly that
    // shape of test and it passed while proving nothing at all.
    const found = REDUCER_FILES.filter((f) => read(f) !== null);
    expect(found).toEqual(REDUCER_FILES);
  });

  const FORBIDDEN = [
    { pattern: /\bnew Date\b|\bDate\.now\b/, name: "Date" },
    { pattern: /\bMath\.random\b/, name: "Math.random" },
    { pattern: /\bfetch\s*\(/, name: "fetch" },
    { pattern: /\bdocument\b/, name: "document" },
    { pattern: /\bwindow\b/, name: "window" },
    { pattern: /\blocalStorage\b/, name: "localStorage" },
    { pattern: /\bperformance\.now\b/, name: "performance.now" },
  ];

  for (const rel of REDUCER_FILES) {
    it(`${rel} reaches for no clock, network, storage or DOM`, () => {
      const source = read(rel);
      expect(source, `${rel} is missing`).not.toBeNull();
      const body = code(source!);
      for (const { pattern, name } of FORBIDDEN) {
        expect(pattern.test(body), `${rel} must not reference ${name}`).toBe(false);
      }
    });

    it(`${rel} imports no framework or platform`, () => {
      const source = read(rel)!;
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const forbidden of ["react", "react-dom", "react-router", "node:", "../api"]) {
        expect(
          imports.filter((s) => s === forbidden || s.startsWith(forbidden)),
          `${rel} must not import ${forbidden}`,
        ).toEqual([]);
      }
    });
  }
});

describe("the draft room is read-only (FR-020, Constitution VI)", () => {
  // Draft Genie observes and advises; it NEVER submits a pick or writes to
  // ESPN. 006 asserts its equivalent structurally by exhausting a fetch mock.
  // Here the surface is a React page, so the assertion is over the source.
  for (const rel of ROOM_FILES) {
    it(`${rel} issues no non-GET request`, () => {
      const source = read(rel);
      // Files that do not exist yet are skipped rather than failing — but the
      // set as a whole is asserted non-empty below, so this cannot go vacuous.
      if (source === null) return;

      // SCANNED AGAINST THE RAW SOURCE, not the stripped body. An HTTP verb IS
      // a string literal, so stripping strings first made this check incapable
      // of firing — it passed against a deliberately planted
      // `fetch('/x', { method: 'POST' })`. Caught by T051, which exists
      // precisely because a guard that has never failed is not known to work.
      const methods = [...source.matchAll(/method\s*:\s*["'`]([A-Za-z]+)["'`]/g)].map((m) =>
        m[1]!.toUpperCase(),
      );
      expect(methods.filter((m) => m !== "GET"), `${rel} must issue only GET`).toEqual([]);

      // The api client's verb-named helpers are the other way a write arrives,
      // and those ARE identifiers, so the stripped body is right for them.
      const body = code(source);
      for (const verb of ["addPreferred", "removePreferred"]) {
        expect(body.includes(verb), `${rel} must not call ${verb} — 006 owns the list`).toBe(false);
      }
    });
  }

  it("checked at least the reducer files", () => {
    const found = ROOM_FILES.filter((f) => read(f) !== null);
    expect(found.length).toBeGreaterThanOrEqual(REDUCER_FILES.length);
  });
});
