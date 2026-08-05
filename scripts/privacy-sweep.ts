// 010 T050 — the fixture and wire-payload privacy sweep.
//
// Runs in node (not the Workers pool, which has no filesystem) so it can walk
// the committed fixtures. Wired into `npm test` as a separate step; this is the
// check that would have caught the real SWIDs I once put in a test file.
//
// It did NOT catch real member NAMES, which shipped to a public repo in two
// fixtures: it only ever looked for GUID shapes and credential literals, so it
// printed "clean" over a `members[]` array full of first and last names. The
// member-identity pass below closes that, and it imports `memberNamesIn` from
// the sanitizer rather than reimplementing it — the first version of this check
// had its own copy of the matching logic, and the copy was the thing that was
// wrong. TypeScript (run via tsx) purely so this import can exist.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { memberNamesIn } from "./sanitize-espn";

const GUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
// A GUID is a placeholder if it is the suite's fixed identity, matches the
// derived pattern the tap sanitizer emits, or is "obviously fabricated" — every
// hex group a single repeated character, which is the convention 001's fixtures
// already use (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE). Enumerated in
// tests/fixtures/espn/README.md.
const MY_SWID = "11111111-2222-3333-4444-555555555555";
const DERIVED = /^00000000-0000-4000-8000-\d{12}$/;
const isFabricated = (g: string) =>
  g.toLowerCase() === MY_SWID || DERIVED.test(g) || g.split("-").every((part) => /^(.)\1*$/.test(part));

// Derived placeholders emitted by the sanitizer, plus the hand-authored
// synthetic identities used by 001's fixtures. Enumerated, not pattern-matched:
// no shape test can tell an invented name from a real one, so each synthetic
// name is a deliberate declaration reviewed once. Documented in
// tests/fixtures/espn/README.md; anything not listed fails the sweep.
const MEMBER_OK = /^(Manager( \d+)?|\d+)$/;
const SYNTHETIC_NAMES = new Set([
  "myteam_mgr", "Morgan", "Mine",
  "rival1", "Ryan", "Rival",
  "cmgr", "Casey", "Mgr",
  "someone",
]);
const ROOTS = ["tests/fixtures", "tests/tap", "tests/contract", "tap", "src", "web/src", "specs"];
const problems: string[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(json|jsonl|ts|tsx|md|js)$/.test(name)) continue;
    const text = readFileSync(p, "utf8");
    for (const g of text.match(GUID) ?? []) {
      if (!isFabricated(g)) problems.push(`${p}: non-placeholder GUID ${g.slice(0, 8)}…`);
    }
    // espn_s2 values are long opaque strings; a literal one must never appear.
    if (/espn_s2\s*[:=]\s*["'][A-Za-z0-9%+/]{40,}/.test(text)) {
      problems.push(`${p}: looks like a literal espn_s2 value`);
    }
    // Member identities. Scoped to `members[]` — the same payloads carry
    // `players[].firstName` for real NFL players, which the fixtures need.
    for (const name of memberNamesIn(text)) {
      if (MEMBER_OK.test(name) || SYNTHETIC_NAMES.has(name)) continue;
      problems.push(`${p}: non-placeholder member name (${name.length} chars) — sanitize it, or add it to SYNTHETIC_NAMES if invented`);
    }
  }
}

for (const r of ROOTS) {
  try { walk(r); } catch { /* optional path */ }
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`privacy sweep FAILED (${unique.length}):`);
  for (const p of unique) console.error(`  ${p}`);
  process.exit(1);
}
console.log("privacy sweep: clean — no non-placeholder GUIDs, no credential literals, no member names");
