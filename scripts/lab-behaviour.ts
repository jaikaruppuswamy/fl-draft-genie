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

function load(): {
  entries: CorpusEntry[];
  adp: Map<number, number>;
  floor: number | null;
  adpSeasons: Set<number>;
} {
  const entries: CorpusEntry[] = [];
  const adp = new Map<number, number>();
  const adpSeasons = new Set<number>();
  let floor: number | null = null;

  if (!existsSync(FIXTURES)) return { entries, adp, floor, adpSeasons };

  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".draft.json")).sort()) {
    entries.push(JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as CorpusEntry);
  }
  // ADP comes from whatever snapshots exist, and each snapshot belongs to a
  // SEASON — which is now tracked, because the season is what decides whether a
  // measurement is meaningful at all.
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".inputs.json")).sort()) {
    const snap = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as InputSnapshot;
    if (snap.adpFloor !== null) floor = snap.adpFloor;
    const season = byId.get(snap.entryId)?.season;
    if (season !== undefined) adpSeasons.add(season);
    for (const p of snap.players) if (p.adp !== null) adp.set(p.espn_player_id, p.adp);
  }
  return { entries, adp, floor, adpSeasons };
}

function main(): void {
  const { entries, adp, floor, adpSeasons } = load();
  const sequences = entries.filter((e) => e.useClass === "pick_sequence_only");

  console.log(`\nADP behaviour over ${sequences.length} pick-sequence-only entr(y|ies)\n`);

  if (sequences.length === 0) {
    console.log("  none in the corpus.");
    console.log("  Import a past season:  npx tsx scripts/lab-import.ts --league <id> --season 2025 --class real\n");
    return;
  }

  // One measurement per ADP season, never a pooled one. Pooling would average
  // across years, which is the mistake this whole check exists to prevent.
  const seasons = adpSeasons.size > 0 ? [...adpSeasons].sort() : [];
  if (seasons.length === 0) {
    console.log("  no snapshot carries ADP, so there is nothing to measure against.\n");
    reportBlocked(sequences.map((e) => e.season));
    return;
  }

  let anyMeasured = false;
  for (const season of seasons) {
    const observed = observeAdpBehaviour(sequences, (id) => adp.get(id) ?? null, floor, season);

    if (observed.refusal) {
      console.log(`  ADP from ${season}: NO MEASUREMENT`);
      console.log(`    ${observed.refusal}\n`);
      continue;
    }

    anyMeasured = true;
    console.log(`  ADP from ${season}`);
    console.log(`    sample .............. ${observed.sampleSize} picks`);
    console.log(`    skipped (no ADP) .... ${observed.skippedNoAdp}`);
    console.log(`    mean delta .......... ${observed.mean}   (negative = taken EARLIER than ADP)`);
    console.log(`    median delta ........ ${observed.median}`);
    console.log(`    standard deviation .. ${observed.standardDeviation}   ← the opponent model's noiseSd`);
    console.log(`    entries ............. ${observed.entriesUsed.join(", ")}\n`);
  }

  if (!anyMeasured) reportBlocked(sequences.map((e) => e.season));
}

/**
 * Say plainly what is missing, and what would unblock it.
 *
 * The first real run of this script reported a standard deviation of 27 from
 * two accidental id collisions, labelled as the opponent model's noise. Silence
 * with a reason beats a number without one.
 */
function reportBlocked(entrySeasons: readonly number[]): void {
  const unique = [...new Set(entrySeasons)].sort();
  console.log(`  FR-020c is currently UNSATISFIABLE, and the reason is structural:`);
  console.log(`    the pick sequences are from ${unique.join(", ")}, and no ADP exists for those seasons —`);
  console.log(`    for exactly the reason they cannot be replayed. The projections pipeline never`);
  console.log(`    covered them, and ESPN serves preseason projections for the CURRENT season only.`);
  console.log(``);
  console.log(`  Measuring them against a later season's ADP would measure a year of player aging,`);
  console.log(`  not how that room drafted. That is refused rather than caveated.`);
  console.log(``);
  console.log(`  What unblocks it: a draft in a season the pipeline covers. That draft is also`);
  console.log(`  replayable, so the same admission serves both purposes.`);
  console.log(`  Until then the opponent model must run with grounded=false.\n`);
}

main();
