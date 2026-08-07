// 008 T012/T025 — the structural guards, asserted by reading source.
//
// Four properties that decay SILENTLY if only a comment defends them:
//
//   FR-035  no lab code is reachable from the deployed Worker
//   FR-008  the lab core is pure — no clock, no network, no randomness
//   FR-036  a RUN reads committed fixtures; only admission touches production
//   FR-019c snapshotting READS the live tables and never writes them
//
// The last is the one this feature would most regret losing. Snapshotting won
// over exempting seasons from the prune precisely because it is ADDITIVE —
// 002's and 004's shipped behaviour untouched. An implementation that
// "helpfully" preserved a projection set would quietly become the option that
// was rejected, and every test here would still pass without this file.
//
// 005 is the cautionary tale: `writeArchive` was built, tested, and never
// called. A comment claiming it ran would have been just as true and just as
// useless as the structural test that actually caught it.
//
// MECHANISM: `import.meta.glob(..., '?raw')` is a Vite BUILD-TIME transform —
// Vite rewrites the literal call and inlines the file contents, so no `node:fs`
// is needed. That matters because `tests/lab/**` is typechecked by the root
// tsconfig, which carries no node types. The call CANNOT be aliased or factored
// into a helper: Vite only recognises the literal form, and anything else
// leaves a real property access at runtime that does not exist.

import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// The options object is written out at every call site rather than hoisted into
// a shared const. That is not style: Vite parses the LITERAL, and hoisting it
// fails the build with "Expected the second argument to be an object literal".
// Confirmed the hard way while writing this file.
const labSources = import.meta.glob("../../src/lab/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const workerSources = import.meta.glob("../../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const labScripts = import.meta.glob("../../scripts/lab-*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Strip comments and string literals so a mention in prose is not a finding. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe("the lab is not part of the deployed Worker (FR-035, SC-008)", () => {
  it("has lab sources to check", () => {
    // Without this the suite below passes vacuously — the failure mode 006's
    // mutation sweep hit when only 10 of 102 tests actually ran.
    expect(Object.keys(labSources).length).toBeGreaterThan(0);
  });

  it("is imported by nothing outside src/lab/", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(workerSources)) {
      if (path.includes("/src/lab/")) continue;
      if (/from\s+["'][^"']*\/lab\//.test(code(source))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("is not reachable from the Worker entry point", () => {
    // The bundler starts at `main: "src/index.ts"`. Walking one level is enough
    // given the rule above holds for every file: if nothing outside src/lab
    // imports it, no depth of graph can reach it.
    const entry = Object.entries(workerSources).find(([p]) => p.endsWith("/src/index.ts"));
    expect(entry).toBeDefined();
    expect(code(entry![1])).not.toMatch(/\/lab\//);
  });
});

describe("the lab core is pure (FR-008, FR-009)", () => {
  const forbidden: [RegExp, string][] = [
    [/\bMath\.random\b/, "randomness must be seeded — see src/lab/rng.ts"],
    [/\bDate\.now\b/, "a replay has no clock"],
    [/\bnew Date\s*\(/, "a replay has no clock"],
    [/\bfetch\s*\(/, "a replay reads committed fixtures, not the network"],
    [/\bprocess\./, "the core takes arguments; the environment belongs to scripts"],
    [/from\s+["']node:/, "the core is typechecked without node types"],
  ];

  for (const [pattern, why] of forbidden) {
    it(`contains no ${pattern.source} — ${why}`, () => {
      const offenders = Object.entries(labSources)
        .filter(([, source]) => pattern.test(code(source)))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  }

  it("proves the check can fail", () => {
    // A guard that cannot fire is decoration. This is the companion assertion
    // 007 shipped SC-003 without, where a hardcoded 0 was asserted to be under
    // 2000 and would have passed against nothing at all.
    expect(/\bMath\.random\b/.test(code("const x = Math.random();"))).toBe(true);
    expect(/\bMath\.random\b/.test(code("// Math.random is banned here"))).toBe(false);
  });
});

describe("a run reads fixtures; only admission touches production (FR-036, FR-037)", () => {
  const RUN_SCRIPTS = ["lab-run.ts", "lab-simulate.ts", "lab-behaviour.ts"];

  it("has run scripts to check", () => {
    const found = Object.keys(labScripts).filter((p) => RUN_SCRIPTS.some((n) => p.endsWith(n)));
    expect(found.length).toBe(RUN_SCRIPTS.length);
  });

  for (const name of RUN_SCRIPTS) {
    it(`${name} issues no D1 or wrangler call`, () => {
      const found = Object.entries(labScripts).find(([p]) => p.endsWith(name));
      expect(found).toBeDefined();
      const body = code(found![1]);
      // A run must work offline, with no production access, or the baseline it
      // produces is not reproducible by anyone else.
      expect(body).not.toMatch(/\bwrangler\b/);
      expect(body).not.toMatch(/\bd1\s+execute\b/i);
      expect(body).not.toMatch(/\bexecFileSync\b|\bexecSync\b|\bspawnSync\b/);
    });
  }
});

describe("snapshotting is ADDITIVE — it never writes the live tables (FR-019c)", () => {
  const ADMIT_SCRIPTS = ["lab-admit.ts", "lab-import.ts"];
  // The tables 002 and 004 own. The lab reads them; the pipelines that own them
  // keep their existing behaviour, unchanged and unaware.
  const OWNED = ["projection_sets", "player_projections", "signal_entries"];

  it("has admitting scripts to check", () => {
    const found = Object.keys(labScripts).filter((p) => ADMIT_SCRIPTS.some((n) => p.endsWith(n)));
    expect(found.length).toBe(ADMIT_SCRIPTS.length);
  });

  for (const name of ADMIT_SCRIPTS) {
    it(`${name} issues no write against 002's or 004's tables`, () => {
      const found = Object.entries(labScripts).find(([p]) => p.endsWith(name));
      expect(found).toBeDefined();
      // Scanned against RAW source, not `code()`: SQL lives in string literals,
      // and stripping them would delete the very thing being checked. 006 hit
      // exactly this — an HTTP verb IS a string literal, so `method: "POST"`
      // became `method: ""` and its FR-020 guard could never fire.
      const raw = found![1];
      for (const verb of ["INSERT", "UPDATE", "DELETE", "REPLACE", "DROP", "ALTER"]) {
        for (const table of OWNED) {
          const pattern = new RegExp(`${verb}[\\s\\S]{0,60}${table}`, "i");
          expect(raw, `${name} must not ${verb} ${table}`).not.toMatch(pattern);
        }
      }
    });
  }

  it("proves the check can fail", () => {
    const sample = `const sql = "DELETE FROM projection_sets WHERE season < ?";`;
    expect(/DELETE[\s\S]{0,60}projection_sets/i.test(sample)).toBe(true);
  });
});

// 011 T063 (FR-039, SC-011) — the widened frame scope is safe ONLY because
// perspective is not widened with it.
//
// 008 banned a leaguemate's frames outright, after an entry was built carrying
// another manager's team. The ban was an over-correction: the mistake was not
// reading someone else's picks — a relayed pick is four integers, and since 011
// a league's picks are shared among its managers by ratified principle. The
// mistake was inferring OWNERSHIP from relay volume, picking the connection
// with 71 batches over the one with 1.
//
// So the rule that replaces the ban is narrow: FRAMES may be league-wide,
// PERSPECTIVE may not. Everything that says whose draft this is — the team,
// the settings, the roster, the preferred list — is read from the operator's
// own connection, and this asserts there is no other path.

const admitSource = import.meta.glob("../../scripts/lab-admit.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

function admit(): string {
  const src = Object.values(admitSource)[0] ?? "";
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

describe("perspective is the operator's own, whoever relayed the frames", () => {
  it("has the admitting script to check", () => {
    expect(admit().length).toBeGreaterThan(1000);
  });

  it("reads the snapshot and team by CONNECTION, never by league alone", () => {
    // `my_team_id` lives on `league_connections`. Selecting it by league would
    // return a row per manager and pick one arbitrarily — which is precisely
    // how another manager's team reached an entry the first time.
    const code = admit();
    const snapshotRead = /FROM league_snapshots[\s\S]{0,320}/.exec(code)?.[0] ?? "";
    expect(snapshotRead, "no snapshot read found").toBeTruthy();
    expect(snapshotRead).toMatch(/s\.connection_id\s*=\s*\$\{q\(connectionId\)\}/);
    expect(snapshotRead).not.toMatch(/espn_league_id/);
  });

  it("takes the preferred list by connection too, or not at all", () => {
    // A preferred list is named in the constitution's isolation clause, so it
    // may never cross an account under any circumstances.
    const code = admit();
    for (const read of code.match(/FROM preferred_players[\s\S]{0,240}/g) ?? []) {
      expect(read).toMatch(/connection_id/);
    }
  });

  it("never derives ownership from how much a connection relayed", () => {
    // The 2026-08-06 defect in one line: ordering or picking by batch volume.
    // Recorded as a standing rule — scope by account in the query, never by row
    // count.
    const code = admit();
    expect(code).not.toMatch(/ORDER BY\s+(COUNT|n|msgs|batches)\b[\s\S]{0,40}DESC/i);
    expect(code).not.toMatch(/sort\([^)]*\b(n|msgs|batches)\b[^)]*\)[\s\S]{0,60}\[0\]/);
  });

  it("uses ONE frame scope for BOTH queries", () => {
    // The bug this exists to stop recurring: the session listing was widened to
    // account scope and the batch fetch was left on connection scope, so the
    // script offered a session and then reported "no retained frames" for the
    // one it had just offered. Both reads must reference the same constant.
    const code = admit();
    const reads = code.match(/FROM tap_batches[\s\S]{0,260}/g) ?? [];
    expect(reads.length, "expected two reads of tap_batches").toBeGreaterThanOrEqual(2);
    for (const r of reads) {
      expect(r, "a tap_batches read that does not use frameScope").toMatch(/\$\{frameScope\}/);
    }
  });

  it("PROVES these checks can fail", () => {
    // Each pattern above must actually fire on the shape it bans, or the guard
    // is decoration — the companion 007 shipped SC-003 without.
    const byLeague = "FROM league_snapshots s JOIN c WHERE s.espn_league_id = ${q(league)}";
    expect(byLeague).toMatch(/espn_league_id/);
    const byVolume = "ORDER BY COUNT(*) DESC LIMIT 1";
    expect(byVolume).toMatch(/ORDER BY\s+(COUNT|n|msgs|batches)\b[\s\S]{0,40}DESC/i);
  });
});
