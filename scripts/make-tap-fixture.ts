// 010 T008 — build the committed tap fixture from a raw Gate 0 capture.
//
// The raw capture is credentialed material (FR-019a) and never enters the repo.
// This produces its sanitized derivative, fail-closed: assertTapClean throws
// before anything is written if a real SWID or league id survives.
//
//   npx tsx scripts/make-tap-fixture.ts <raw-capture.json> <out.jsonl>

import { readFileSync, writeFileSync } from "node:fs";
import { deriveTapMapping, sanitizeTapFrame, assertTapClean, type TapFrame } from "./sanitize-espn";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: npx tsx scripts/make-tap-fixture.ts <raw-capture.json> <out.jsonl>");
  process.exit(2);
}

const src = JSON.parse(readFileSync(inPath, "utf8")) as { entries: TapFrame[] };
const mapping = deriveTapMapping(src.entries);
const unknown = new Map<string, string>();
const clean = src.entries.map((f) => sanitizeTapFrame(f, mapping, unknown));

assertTapClean(clean, mapping);
writeFileSync(outPath, clean.map((f) => JSON.stringify(f)).join("\n") + "\n");

const verbs = new Map<string, number>();
for (const f of clean) {
  if (f.transport === "ws" && f.event === "message" && f.enc === "text" && f.data) {
    const v = f.data.split(" ")[0]!.trim();
    verbs.set(v, (verbs.get(v) ?? 0) + 1);
  }
}
console.log(`frames: ${clean.length}, SWIDs mapped: ${mapping.guid.size}, unknown GUIDs scrubbed: ${unknown.size}`);
console.log("verbs:", Object.fromEntries([...verbs].sort((a, b) => b[1] - a[1])));
