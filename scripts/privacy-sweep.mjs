// 010 T050 — the fixture and wire-payload privacy sweep.
//
// Runs in node (not the Workers pool, which has no filesystem) so it can walk
// the committed fixtures. Wired into `npm test` as a separate step; this is the
// check that would have caught the real SWIDs I once put in a test file.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const GUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
// A GUID is a placeholder if it is the suite's fixed identity, matches the
// derived pattern the tap sanitizer emits, or is "obviously fabricated" — every
// hex group a single repeated character, which is the convention 001's fixtures
// already use (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE). Enumerated in
// tests/fixtures/espn/README.md.
const MY_SWID = "11111111-2222-3333-4444-555555555555";
const DERIVED = /^00000000-0000-4000-8000-\d{12}$/;
const isFabricated = (g) =>
  g.toLowerCase() === MY_SWID || DERIVED.test(g) || g.split("-").every((part) => /^(.)\1*$/.test(part));

const ROOTS = ["tests/fixtures", "tests/tap", "tests/contract", "tap", "src", "web/src", "specs"];
const problems = [];

function walk(dir) {
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
console.log("privacy sweep: clean — no non-placeholder GUIDs, no credential literals");
