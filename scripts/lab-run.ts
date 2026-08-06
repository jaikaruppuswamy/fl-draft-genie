// 008 T019/T022/T034/T038/T039 — replay the corpus and score it.
//
//   npx tsx scripts/lab-run.ts [--entry <id>] [--baseline <path>]
//                              [--write-baseline <path>] [--json]
//
// THE COMMAND SC-001 IS MEASURED ON, and the one a tuning session actually
// uses: change a constant, re-run, read the diff.
//
// It reads COMMITTED FIXTURES ONLY. No D1, no wrangler, no network — asserted
// structurally by `tests/lab/boundary.test.ts`. That is what makes a baseline
// reproducible by someone who is not the person who produced it, which is the
// difference between a review gate and a number someone reports.
//
// The engine content hash is computed HERE rather than in `src/lab/scorecard.ts`
// because the pure core has no filesystem — it is typechecked without node
// types — and this script runs under tsx, where `import.meta.glob` does not
// exist. Neither mechanism is available inside the core.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, snapshotToBundle, type InputSnapshot } from "../src/lab/codec";
import { validateEntry, type CorpusEntry } from "../src/lab/corpus";
import { fidelityFor, replayEntry } from "../src/lab/replay";
import { buildScorecard, type Scorecard } from "../src/lab/scorecard";
import { compareScorecards, isEmpty } from "../src/lab/compare";

const FIXTURES = "tests/fixtures/lab";
const ENGINE_DIR = "src/engine";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * FNV-1a over every engine source, in sorted order.
 *
 * Catches a rule change that left the constants untouched — otherwise two
 * scorecards would compare as though nothing had happened (FR-011).
 */
function engineVersion(): string {
  const files = readdirSync(ENGINE_DIR).filter((f) => f.endsWith(".ts")).sort();
  let text = "";
  for (const f of files) text += `${f}\n${readFileSync(join(ENGINE_DIR, f), "utf8")}`;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) & MASK) * PRIME & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

interface Loaded {
  entry: CorpusEntry;
  snapshot: InputSnapshot | null;
}

function loadCorpus(only?: string): Loaded[] {
  if (!existsSync(FIXTURES)) return [];
  const out: Loaded[] = [];
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".draft.json")).sort()) {
    const entry = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as CorpusEntry;
    if (only && entry.id !== only) continue;
    const inputsPath = join(FIXTURES, file.replace(".draft.json", ".inputs.json"));
    const snapshot = existsSync(inputsPath)
      ? (JSON.parse(readFileSync(inputsPath, "utf8")) as InputSnapshot)
      : null;

    // Refuse a bad entry loudly. A silently skipped draft shrinks a corpus
    // without anyone noticing, and a smaller corpus is a quieter comparison.
    const violations = validateEntry(entry, snapshot !== null);
    if (violations.length > 0) {
      for (const v of violations) console.error(`  ✗ ${v.entryId}: ${v.invariant} — ${v.detail}`);
      throw new Error(`${entry.id} failed ${violations.length} invariant(s)`);
    }
    out.push({ entry, snapshot });
  }
  return out;
}

function run(): Scorecard {
  const loaded = loadCorpus(arg("entry"));
  if (loaded.length === 0) {
    console.error(`no corpus entries found under ${FIXTURES}/`);
    console.error("  admit a draft first:  npx tsx scripts/lab-admit.ts --league <id> --season 2026 --class real");
    process.exit(1);
  }

  const considered = loaded.map(({ entry, snapshot }) => {
    const fidelity = fidelityFor(entry, false);
    if (entry.useClass !== "replayable" || snapshot === null) {
      return { entry, fidelity, turns: null };
    }
    return { entry, fidelity, turns: replayEntry(entry, snapshotToBundle(snapshot)).turns };
  });

  return buildScorecard({ considered, engineVersion: engineVersion() });
}

function report(card: Scorecard): void {
  if (has("json")) {
    console.log(canonicalJson(card, { round: 4 }));
    return;
  }

  console.log(`\nengine ${card.ruleSet.engineVersion}   scorecard ${card.hash}\n`);

  for (const e of card.entries) {
    console.log(`  ${e.entryId} — ${e.turns.length} owner turn(s)`);
    for (const t of e.turns) {
      const head = t.engineHead ? `${t.engineHead.name}` : "—";
      const took = t.actual
        ? `${t.actual.name} (rank ${t.actual.rank}${t.gapInRounds !== null ? `, ${t.gapInRounds.toFixed(2)} rounds behind` : ""})`
        : `player ${t.actualPlayerId} — NOT ON THE BOARD`;
      console.log(`    ${String(t.round)}.${String(t.roundPick).padStart(2, "0")}  engine: ${head}`);
      console.log(`           took:   ${took}`);
      if (t.decisiveRule) console.log(`           decided by: ${t.decisiveRule}`);
      if (t.forced) console.log(`           (forced — the engine was not choosing)`);
    }
  }

  for (const x of card.excluded) console.log(`  — ${x.entryId} excluded: ${x.reason}`);

  // Fidelity, always. A run that does not say which inputs were reconstructed
  // and which were borrowed from today produces numbers that look
  // authoritative and are not (FR-015).
  const notes = new Set(card.fidelity.flatMap((f) => f.notes));
  if (card.fidelity.length > 0) {
    const f = card.fidelity[0]!;
    console.log(`\n  fidelity: board ${f.board}, signals ${f.signals}, preferred ${f.preferred}, scoring ${f.scoring}`);
    for (const n of notes) console.log(`    · ${n}`);
  }

  const b = card.behavioural;
  console.log(`\n  turns ................ ${b.turnCount}`);
  console.log(`  head agreement ....... ${(b.headAgreementRate * 100).toFixed(1)}%`);
  console.log(`  mean gap (rounds) .... ${b.meanGapInRounds ?? "—"}`);
  console.log(`  median gap (rounds) .. ${b.medianGapInRounds ?? "—"}`);
  console.log(`  forced turns ......... ${b.forcedTurnCount}`);
  console.log(`  off-board picks ...... ${b.offBoardPickCount}`);
  if (b.decisiveRuleCounts.length > 0) {
    console.log(`  decisive rules ....... ${b.decisiveRuleCounts.map((r) => `${r.rule}×${r.count}`).join(", ")}`);
  }
  console.log(`  rank distribution .... ${b.actualRankDistribution.map((r) => `${r.bucket}:${r.count}`).join("  ")}`);

  // FR-017a: stated as empty, never omitted and never filled with a
  // projection-derived stand-in.
  console.log(`\n  outcome (actual season points): NOT YET AVAILABLE — the season has not been played.`);
  console.log(`  Everything above describes what the engine DID, not whether it was right.\n`);
}

function main(): void {
  const card = run();

  if (card.entries.length === 0) {
    // FR-027d / SC-010. Comparing over test entries is worse than not
    // comparing: it produces a number that looks like evidence.
    console.error("\nno ADMISSIBLE entries — nothing to score.\n");
    for (const x of card.excluded) console.error(`  — ${x.entryId}: ${x.reason}`);
    console.error("\nThe evidential corpus needs at least one entry that is both replayable and real.\n");
    process.exit(1);
  }

  report(card);

  const writeTo = arg("write-baseline");
  if (writeTo) {
    mkdirSync(join(FIXTURES, "baselines"), { recursive: true });
    writeFileSync(writeTo, canonicalJson(card, { round: 4 }));
    console.log(`  baseline written to ${writeTo}\n`);
  }

  const baselinePath = arg("baseline");
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Scorecard;
    const c = compareScorecards(baseline, card);

    if (c.corpusMismatch.length > 0) {
      console.log(`  ⚠ corpus mismatch: ${c.corpusMismatch.join(", ")} — this is not a like-for-like comparison`);
    }

    if (isEmpty(c)) {
      console.log(`  no change against ${baselinePath} (threshold: rank ≥ ${c.threshold.rankMovement}, ${c.threshold.valueInRounds} rounds)\n`);
      return;
    }

    if (c.determinismFailure) {
      // Not a finding. A fault — and every comparison is worthless until it is
      // fixed, so this exits non-zero rather than printing movement.
      console.error(`\n  ✗ DETERMINISM FAILURE — identical rules produced different results.`);
      console.error(`    ${c.headChanges.length} head change(s), ${c.movements.length} movement(s) with no rule change.`);
      console.error(`    Check the codec's sort order before reading anything above as a rule effect.\n`);
      process.exit(1);
    }

    console.log(`  against ${baselinePath} (threshold: rank ≥ ${c.threshold.rankMovement}, ${c.threshold.valueInRounds} rounds)\n`);
    for (const h of c.headChanges) {
      console.log(`    ${h.entryId} @${h.overall}: ${h.from?.name ?? "—"} → ${h.to?.name ?? "—"}`);
    }
    for (const m of c.movements) {
      console.log(`    ${m.entryId} @${m.overall}: rank moved ${m.maxRankDelta}, value ${m.valueDeltaInRounds >= 0 ? "+" : ""}${m.valueDeltaInRounds} rounds`);
    }
    console.log(`\n    head agreement ${c.aggregateDeltas.headAgreementRate >= 0 ? "+" : ""}${(c.aggregateDeltas.headAgreementRate * 100).toFixed(1)} pts\n`);
  }
}

main();
