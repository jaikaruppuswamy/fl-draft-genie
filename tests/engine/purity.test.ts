// 006 T002 — the structural guard.
//
// Two properties that decay SILENTLY if only a comment defends them:
//
//   FR-010  the engine is pure — no clock, no I/O, no ambient state
//   FR-011  no rule weight is reachable as a user-facing setting (Constitution IV)
//
// Both are asserted by reading the source, not by trusting it. 005 taught this
// the expensive way: `writeArchive` was built, tested, and never called, and a
// comment saying the session held no credential would have been just as true
// and just as useless as the structural test that actually caught it.
//
// NOTE ON THE MECHANISM: `import.meta.glob(..., '?raw')` is resolved by Vite at
// build time, so the file contents are inlined and no `node:fs` is needed —
// which matters because this runs in the workers pool, where there is no fs.

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite BUILD-TIME transform: Vite rewrites the literal
// call and inlines the matched file contents. It only recognises the literal
// form, so the call below cannot be aliased or factored out — doing so leaves
// a real property access at runtime, which does not exist.
//
// The declaration merge is local rather than a tsconfig-wide `vite/client`
// because this is the only file in the project that needs it.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

const engineSources = import.meta.glob("../../src/engine/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const apiSources = import.meta.glob("../../src/api/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Strip comments and string literals before scanning.
 *
 * Without this the guard fires on its own documentation — every file in
 * `src/engine/` explains WHY it may not touch the clock, and the word "Date"
 * appears in that explanation. A guard that cannot survive being commented is
 * a guard nobody will keep.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\/\/[^\n]*/g, " ") // line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // single-quoted
    .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // template literals
}

describe("the engine is pure (FR-010)", () => {
  it("has files to check — a guard over an empty set proves nothing", () => {
    // The failure this exists to prevent: the glob pattern drifts, matches
    // nothing, and every assertion below passes vacuously forever.
    expect(Object.keys(engineSources).length).toBeGreaterThanOrEqual(5);
  });

  const FORBIDDEN_IMPORTS = [
    "cloudflare:",
    "hono",
    "../db/",
    "../api/",
    "../sync/",
    "node:",
  ];

  // `Date` and `crypto` are the two that would break offline replay (FR-014)
  // and reproducibility from the archive (SC-010); `Math.random` and `fetch`
  // break determinism outright (FR-010).
  const FORBIDDEN_TOKENS = [
    { pattern: /\bnew Date\b|\bDate\.now\b/, name: "Date" },
    { pattern: /\bMath\.random\b/, name: "Math.random" },
    { pattern: /\bfetch\s*\(/, name: "fetch" },
    { pattern: /\bcrypto\b/, name: "crypto" },
    { pattern: /\bperformance\.now\b/, name: "performance.now" },
  ];

  for (const [path, source] of Object.entries(engineSources)) {
    const body = code(source);

    it(`${path} imports nothing from the platform`, () => {
      // NO EXEMPTIONS. The bundle loader reads five D1 tables and therefore
      // lives at `src/db/engineBundle.ts` — outside this tree — precisely so
      // that this list never needs an "except…". An exemption is how a
      // categorically pure tree stops being one.
      //
      // Scanned against the RAW source, not the stripped body: import
      // specifiers are the one kind of string literal that must still be read.
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.filter((s) => s.includes(forbidden)),
          `${path} must not import ${forbidden}`,
        ).toEqual([]);
      }
    });

    it(`${path} reaches for no clock, network or randomness`, () => {
      for (const { pattern, name } of FORBIDDEN_TOKENS) {
        expect(pattern.test(body), `${path} must not reference ${name}`).toBe(false);
      }
    });
  }
});

describe("no rule weight is a user-facing setting (FR-011, Constitution IV)", () => {
  it("has API files to check", () => {
    expect(Object.keys(apiSources).length).toBeGreaterThanOrEqual(5);
  });

  for (const [path, source] of Object.entries(apiSources)) {
    it(`${path} does not import the engine's constants`, () => {
      // The rules are the product. A route that can read `WEIGHT` is one commit
      // away from a route that can write it, and Constitution IV is explicit
      // that no such surface exists. The engine consumes its own constants;
      // nothing above it needs to see them.
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(
        imports.filter((s) => s.includes("engine/constants")),
        `${path} must not import engine/constants`,
      ).toEqual([]);
    });

    it(`${path} registers no settings route`, () => {
      const routes = [...source.matchAll(/app\.(?:get|post|put|delete|patch)\(\s*["']([^"']*)["']/g)].map(
        (m) => m[1]!,
      );
      expect(routes.filter((r) => /settings|weights|tuning/i.test(r))).toEqual([]);
    });
  }
});
