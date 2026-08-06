// 008 T053 — how real drafters behaved relative to ADP.
//
//   npx tsx scripts/lab-behaviour.ts
//
// Reads `pick_sequence_only` entries — the ones that can never be replayed —
// and reports the spread of (pick overall − ADP). That number is what sets the
// opponent model's noise from data rather than from taste, and it is the entire
// reason those unreplayable imports are worth keeping.
//
// THE ENGINE IS NEVER INVOKED HERE, and cannot be: these entries have no
// contemporaneous board. Committed fixtures only — no D1, no network.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { observeAdpBehaviour } from "../src/lab/behaviour";
import type { CorpusEntry } from "../src/lab/corpus";
import type { InputSnapshot } from "../src/lab/codec";

const FIXTURES = "tests/fixtures/lab";

function load(): { entries: CorpusEntry[]; adp: Map<number, number>; floor: number | null } {
  const entries: CorpusEntry[] = [];
  const adp = new Map<number, number>();
  let floor: number | null = null;

  if (!existsSync(FIXTURES)) return { entries, adp, floor };

  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".draft.json")).sort()) {
    entries.push(JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as CorpusEntry);
  }
  // ADP comes from whatever snapshots exist — a pick-sequence-only entry has
  // none of its own, so the values are necessarily present-day. That is stated
  // in the output rather than quietly assumed away.
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".inputs.json")).sort()) {
    const snap = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as InputSnapshot;
    if (snap.adpFloor !== null) floor = snap.adpFloor;
    for (const p of snap.players) if (p.adp !== null) adp.set(p.espn_player_id, p.adp);
  }
  return { entries, adp, floor };
}

function main(): void {
  const { entries, adp, floor } = load();
  const sequences = entries.filter((e) => e.useClass === "pick_sequence_only");

  console.log(`\nADP behaviour over ${sequences.length} pick-sequence-only entr(y|ies)\n`);

  if (sequences.length === 0) {
    console.log("  none in the corpus.");
    console.log("  Import a past season:  npx tsx scripts/lab-import.ts --league <id> --season 2024 --class real");
    console.log("  If Gate 0 found past seasons unavailable, this measurement cannot be made at all,");
    console.log("  and the opponent model must be run with grounded=false so its noise says it is a guess.\n");
    return;
  }

  const observed = observeAdpBehaviour(sequences, (id) => adp.get(id) ?? null, floor);

  console.log(`  sample .............. ${observed.sampleSize} picks`);
  console.log(`  skipped (no ADP) .... ${observed.skippedNoAdp}`);
  console.log(`  mean delta .......... ${observed.mean ?? "—"}   (negative = taken EARLIER than ADP)`);
  console.log(`  median delta ........ ${observed.median ?? "—"}`);
  console.log(`  standard deviation .. ${observed.standardDeviation ?? "—"}   ← the opponent model's noiseSd`);
  console.log(`  entries ............. ${observed.entriesUsed.join(", ") || "—"}`);
  console.log(`\n  ADP values are PRESENT-DAY: a pick-sequence-only entry carries no snapshot of its own.\n`);
}

main();
