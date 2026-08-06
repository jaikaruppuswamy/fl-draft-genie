// 008 T059 — run a draft the engine plays itself.
//
//   npx tsx scripts/lab-simulate.ts --entry <id> --seed 42 [--noise 3] [--json]
//
// The engine makes the owner's picks, modelled opponents make the rest, and the
// resulting roster is shown beside the one the owner actually built.
//
// EVERY LINE OF OUTPUT IS MODEL-DEPENDENT and the script says so, loudly, at
// the end. Once the engine takes a different player the rest of the draft is a
// model's opinion rather than a record — so a finding from here must never be
// filed next to a shadow replay as though the two carried equal weight.
//
// Committed fixtures only: no D1, no network.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, snapshotToBundle, type InputSnapshot } from "../src/lab/codec";
import type { CorpusEntry } from "../src/lab/corpus";
import { simulateDraft, type OpponentModel } from "../src/lab/simulate";

const FIXTURES = "tests/fixtures/lab";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function main(): void {
  const id = arg("entry");
  const seed = Number(arg("seed") ?? "42");
  const noise = Number(arg("noise") ?? "3");

  if (!id) {
    const available = existsSync(FIXTURES)
      ? readdirSync(FIXTURES).filter((f) => f.endsWith(".draft.json")).map((f) => f.replace(".draft.json", ""))
      : [];
    console.error("usage: npx tsx scripts/lab-simulate.ts --entry <id> [--seed 42] [--noise 3]");
    console.error(`  available: ${available.join(", ") || "(none)"}`);
    process.exit(2);
  }

  const entryPath = join(FIXTURES, `${id}.draft.json`);
  const inputsPath = join(FIXTURES, `${id}.inputs.json`);
  if (!existsSync(entryPath) || !existsSync(inputsPath)) {
    console.error(`no replayable entry named ${id}`);
    process.exit(1);
  }

  const entry = JSON.parse(readFileSync(entryPath, "utf8")) as CorpusEntry;
  const snapshot = JSON.parse(readFileSync(inputsPath, "utf8")) as InputSnapshot;

  if (entry.useClass !== "replayable") {
    console.error(`${id} is not replayable: ${entry.unreplayableReason ?? "no board"}`);
    process.exit(1);
  }

  // `grounded` is false unless a measurement exists. `lab-behaviour.ts` reports
  // the number; until someone has run it against real past drafts, the noise is
  // a guess and the output must admit it rather than imply a measurement.
  const model: OpponentModel = {
    kind: "adp_noise",
    noiseSd: noise,
    grounded: arg("noise") !== undefined,
    seed,
  };

  const result = simulateDraft(entry, snapshotToBundle(snapshot), model);

  if (process.argv.includes("--json")) {
    console.log(canonicalJson(result, { round: 4 }));
    return;
  }

  console.log(`\n${id} — simulated with ${model.kind}, seed ${model.seed}, noise ${model.noiseSd}\n`);
  console.log(`  engine's roster                    owner's actual roster`);
  const rows = Math.max(result.engineRoster.length, result.ownerRoster.length);
  for (let i = 0; i < rows; i++) {
    const a = result.engineRoster[i];
    const b = result.ownerRoster[i];
    const left = a ? `${a.position.padEnd(3)} ${a.name}` : "";
    const right = b ? `${b.position.padEnd(3)} ${b.name}` : "";
    console.log(`  ${left.padEnd(34)} ${right}`);
  }

  console.log(`\n  ⚠ MODEL-DEPENDENT. Once the engine takes a different player, every later pick`);
  console.log(`    in the real draft becomes counterfactual — the opponents would have faced a`);
  console.log(`    different board. This is an estimate, not a record.`);
  if (!model.grounded) {
    console.log(`    The noise (${model.noiseSd}) was NOT measured from real drafts. Run lab-behaviour.ts.`);
  }
  console.log("");
}

main();
