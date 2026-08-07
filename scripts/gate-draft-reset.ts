// 011 T001 — GATE. Does ESPN's draft-completion flag flip back after a reset?
//
//   ESPN_S2='...' SWID='{...}' npx tsx scripts/gate-draft-reset.ts --league <id>
//   … reset the draft in ESPN …
//   ESPN_S2='...' SWID='{...}' npx tsx scripts/gate-draft-reset.ts --league <id>
//
// THE QUESTION: US8 (Phase 8) rests entirely on ESPN reporting a reset draft as
// no longer completed, and nobody has checked. What *is* verified is only that
// mock drafts never appear in ESPN's league record at all (`started=0,
// completed=0`, measured against two captured 72-pick drafts) — a different
// fact about a different thing, which cannot stand in for this one.
//
// WHY TWO RUNS RATHER THAN ONE READ. The premise is a TRANSITION: `drafted:
// true` becoming `drafted: false` for the same league in the same season.
// Reading a past season's finished draft measures persistence, not reversal;
// reading a fresh league measures neither. So the gate takes a baseline of a
// league whose draft is complete NOW, waits for a real reset, and reads again.
// The two runs are the experiment; the file between them is only the memory.
//
// THREE READS PER RUN, 2.5 s apart. FR-031f says an ambiguous report voids
// nothing, so a gate that looks once cannot separate "the flag flipped" from
// "one response was odd". Reads that disagree within a run ARE the finding: the
// signal flaps, and US8 must not be keyed on something that flaps.
//
// `drafted` IS TRACKED AS THREE STATES — true, false and absent. Production
// parses `res.draftDetail?.drafted ?? false` (src/espn/parsers.ts), so a missing
// field and a false one land in the same place. If ESPN answers a reset league
// by dropping the field, that coercion turns "we don't know" into "reset" and
// FR-031f is broken by the parse rather than by the rule. Only a probe that
// keeps the two apart can see it coming.
//
// READ-ONLY, summary only: no fixture is written, the cookies never reach a URL
// or a log line, and the state file carries flags, counts and a digest — never
// a name, a GUID or a response body.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEspnClient, type EspnView } from "../src/espn/client";
import type { Env } from "../src/env";
import { EspnError, type EspnLeagueResponse } from "../src/espn/types";

const VIEWS: EspnView[] = ["mSettings", "mDraftDetail"];
const DEFAULT_STATE = ".gate/011-draft-reset.json";
const DEFAULT_READS = 3;
const SPACING_MS = 2500; // stay polite (FR-008)

/** ESPN pre-populates a placeholder skeleton with `playerId: -1`. A real pick is
 *  anything else — INCLUDING negative ids near -16000, which are D/ST. Filtering
 *  on sign is what made 010's capture script report 66 of 72 picks for a
 *  complete draft, so this compares against the skeleton value and nothing else. */
const SKELETON_PLAYER_ID = -1;

type Tri = "true" | "false" | "absent";

interface Observation {
  draftDetailPresent: boolean;
  drafted: Tri;
  inProgress: Tri;
  pickRows: number;
  filledPicks: number;
  skeletonPicks: number;
  /** Short hash of the ordered pick sequence — enough to say "same draft" or
   *  "different draft" without keeping the draft. Empty when there are none. */
  digest: string;
  draftType: string | null;
  scheduledAt: string | null;
}

interface Run {
  at: string;
  reads: Observation[];
  /** The reading all reads agreed on, or null when they disagreed. */
  consensus: Observation | null;
}

interface GateState {
  gate: "011-T001";
  league: string;
  season: number;
  baseline: Run;
  /** Refreshed by every comparison run, so the baseline stays comparable and a
   *  reset that has not propagated yet can simply be re-read. */
  latest?: Run;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function tri(o: object | undefined | null, key: string): Tri {
  if (!o || !(key in o)) return "absent";
  const v = (o as Record<string, unknown>)[key];
  return v === true ? "true" : v === false ? "false" : "absent";
}

async function observe(
  client: ReturnType<typeof createEspnClient>,
  season: number,
  league: string,
): Promise<Observation> {
  const res = (await client.fetchLeague(season, league, VIEWS)) as EspnLeagueResponse;
  const dd = res.draftDetail;
  const picks = dd?.picks ?? [];

  let filledPicks = 0;
  let skeletonPicks = 0;
  const seq: string[] = [];
  for (const p of picks) {
    const id = Number(p.playerId);
    if (!Number.isInteger(id) || id === SKELETON_PLAYER_ID) {
      skeletonPicks++;
      continue;
    }
    filledPicks++;
    seq.push(`${Number(p.overallPickNumber)}:${id}`);
  }
  seq.sort();

  const ds = res.settings?.draftSettings;
  return {
    draftDetailPresent: dd !== undefined && dd !== null,
    drafted: tri(dd, "drafted"),
    inProgress: tri(dd, "inProgress"),
    pickRows: picks.length,
    filledPicks,
    skeletonPicks,
    digest: filledPicks > 0 ? createHash("sha256").update(seq.join(",")).digest("hex").slice(0, 16) : "",
    draftType: ds?.type ?? null,
    scheduledAt: typeof ds?.date === "number" ? new Date(ds.date).toISOString() : null,
  };
}

/** The fields whose stability decides whether a run is trustworthy at all.
 *  `draftType` and `scheduledAt` are deliberately excluded: a commissioner may
 *  legitimately move the draft date between two reads, and that should not make
 *  the completion signal look flappy. They are still compared ACROSS runs. */
const CORE: (keyof Observation)[] = [
  "draftDetailPresent",
  "drafted",
  "inProgress",
  "pickRows",
  "filledPicks",
  "skeletonPicks",
  "digest",
];
const core = (o: Observation) => JSON.stringify(CORE.map((k) => o[k]));

async function runOnce(
  client: ReturnType<typeof createEspnClient>,
  season: number,
  league: string,
  reads: number,
): Promise<Run> {
  const out: Observation[] = [];
  for (let i = 0; i < reads; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
    try {
      const o = await observe(client, season, league);
      out.push(o);
      console.log(
        `  read ${i + 1}/${reads}  drafted=${o.drafted.padEnd(6)} inProgress=${o.inProgress.padEnd(6)} ` +
          `pickRows=${String(o.pickRows).padStart(3)} filled=${String(o.filledPicks).padStart(3)} ` +
          `skeleton=${String(o.skeletonPicks).padStart(3)} digest=${o.digest || "—"}`,
      );
    } catch (e) {
      console.log(`  read ${i + 1}/${reads}  ERROR ${e instanceof EspnError ? e.code : (e as Error).message}`);
    }
  }
  if (out.length === 0) {
    throw new Error("every read failed — ESPN unreadable, nothing can be concluded");
  }
  const agreed = out.every((o) => core(o) === core(out[0]));
  if (!agreed) {
    console.log("  ! reads disagree with each other — this run is ambiguous (FR-031f)");
  }
  return { at: new Date().toISOString(), reads: out, consensus: agreed ? out[0] : null };
}

function table(before: Observation, after: Observation): void {
  const rows: [string, string, string][] = [
    ["draftDetail present", String(before.draftDetailPresent), String(after.draftDetailPresent)],
    ["drafted", before.drafted, after.drafted],
    ["inProgress", before.inProgress, after.inProgress],
    ["pick rows", String(before.pickRows), String(after.pickRows)],
    ["filled picks", String(before.filledPicks), String(after.filledPicks)],
    ["skeleton picks", String(before.skeletonPicks), String(after.skeletonPicks)],
    ["pick digest", before.digest || "—", after.digest || "—"],
    ["draft type", before.draftType ?? "—", after.draftType ?? "—"],
    ["scheduled at", before.scheduledAt ?? "—", after.scheduledAt ?? "—"],
  ];
  console.log(`\n  ${"field".padEnd(22)}${"baseline".padEnd(26)}now`);
  for (const [k, a, b] of rows) {
    console.log(`  ${k.padEnd(22)}${a.padEnd(26)}${b}${a === b ? "" : "   <-- changed"}`);
  }
}

/** PASS / PARTIAL / FAIL / INCONCLUSIVE, and why. */
function verdict(before: Observation, after: Observation): { pass: boolean; lines: string[] } {
  const picksCollapsed = before.filledPicks > 0 && after.filledPicks === 0;
  const picksChanged = before.digest !== after.digest;

  if (before.drafted !== "true") {
    return {
      pass: false,
      lines: [
        "INCONCLUSIVE — the baseline did not show a completed draft, so there is",
        "no completion to reverse. Complete a draft, re-run with --rebaseline,",
        "then reset and run again.",
      ],
    };
  }
  if (!after.draftDetailPresent) {
    return {
      pass: false,
      lines: [
        "INCONCLUSIVE — ESPN returned no draftDetail at all. Nothing is voided on",
        "an unreadable report (FR-031f), and note the hazard: production parses",
        "`draftDetail?.drafted ?? false`, which would read this absence as a",
        "reset. If this recurs, T050's comparison must require the field to be",
        "PRESENT before it treats false as a signal.",
      ],
    };
  }
  if (after.drafted === "absent") {
    return {
      pass: false,
      lines: [
        "INCONCLUSIVE, AND A FINDING — draftDetail came back but `drafted` is gone.",
        "Production's `?? false` turns that into completed=false, i.e. a reset that",
        "ESPN never reported. T050 must distinguish absent from false, or FR-031f",
        "is violated by the parse rather than by the rule.",
      ],
    };
  }
  if (after.drafted === "false") {
    return {
      pass: true,
      lines: [
        "GATE PASSES — ESPN's completion flag flipped true -> false for the same",
        "league and season. US8's premise holds: a reset is observable in ESPN's",
        "own report, so Phase 8 has a signal and T049/T050 can key on it.",
        picksCollapsed
          ? "The pick record emptied alongside the flag — a second, corroborating signal."
          : `The pick record did NOT empty (${after.filledPicks} filled picks remain), so the FLAG is the signal, not the picks.`,
      ],
    };
  }
  // drafted stayed true.
  if (picksCollapsed || picksChanged) {
    return {
      pass: false,
      lines: [
        "PARTIAL — `drafted` stayed true, but ESPN's pick record changed",
        picksCollapsed
          ? `(${before.filledPicks} filled picks -> 0).`
          : "(the pick sequence differs, so this is a different draft).",
        "That is still a change in ESPN's OWN report and satisfies FR-031a1, so",
        "US8 need not collapse — but T049/T050 must key on the pick record rather",
        "than on the flag, and the spec's wording ('no longer completed') needs",
        "correcting to match what ESPN actually does.",
      ],
    };
  }
  return {
    pass: false,
    lines: [
      "NO CHANGE — ESPN reports exactly what it did before the reset.",
      "Before concluding: confirm the reset really happened in ESPN, and re-run",
      "in a few minutes (ESPN's league record is written by a flush, not live).",
      "If it still does not change, the gate FAILS: Phase 8 has no signal, US8",
      "collapses, and US5's owner-initiated reset is the only reset path. Record",
      "that in tasks.md T001 and in spec.md rather than building against a signal",
      "that never arrives.",
    ],
  };
}

async function main() {
  const league = arg("league");
  const season = Number(arg("season", String(new Date().getFullYear())));
  const statePath = arg("state", DEFAULT_STATE)!;
  const reads = Math.max(1, Number(arg("reads", String(DEFAULT_READS))));
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.SWID;

  if (!league || !espnS2 || !swid || !Number.isInteger(season)) {
    console.error(
      "usage: ESPN_S2='...' SWID='{...}' npx tsx scripts/gate-draft-reset.ts --league <id>\n" +
        "       [--season <y>] [--state <path>] [--reads <n>] [--rebaseline] [--show]\n\n" +
        "  run 1 (draft complete)  records the baseline\n" +
        "  … reset the draft in ESPN …\n" +
        "  run 2 (same flags)      compares and prints the verdict\n\n" +
        "  --rebaseline  discard the stored baseline and start the experiment over\n" +
        "  --show        read and print current state without touching the baseline",
    );
    process.exit(2);
  }

  // ESPN_BASE_URL exists so the two-run protocol can be REHEARSED against a
  // local stub before a real reset is spent on it — a gate you only find out is
  // wrong after the irreversible step is not much of a gate. The cookie pair
  // travels with every request, so this must never point anywhere but a stub
  // you are running yourself.
  const client = createEspnClient({ ESPN_BASE_URL: process.env.ESPN_BASE_URL } as Env, { espnS2, swid });

  if (flag("show")) {
    console.log(`league ${league} (${season}) — current state, baseline untouched\n`);
    const run = await runOnce(client, season, league, reads);
    console.log(run.consensus ? "\nreads agree." : "\nreads DISAGREE — ambiguous.");
    return;
  }

  let state: GateState | null = null;
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as GateState;
    if (parsed.gate === "011-T001") state = parsed;
  } catch {
    /* no baseline yet — first run */
  }

  if (state && !flag("rebaseline") && (state.league !== league || state.season !== season)) {
    console.error(
      `baseline in ${statePath} is for league ${state.league} (${state.season}), not ${league} (${season}).\n` +
        "Comparing across leagues would prove nothing. Use --state <other path>, or --rebaseline to start over.",
    );
    process.exit(2);
  }

  // ---- RUN 1: record the baseline -----------------------------------------
  if (!state || flag("rebaseline")) {
    console.log(`league ${league} (${season}) — recording the BASELINE (run 1 of 2)\n`);
    const baseline = await runOnce(client, season, league, reads);
    await mkdir(dirname(statePath), { recursive: true });
    const next: GateState = { gate: "011-T001", league, season, baseline };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nbaseline written to ${statePath}`);

    const c = baseline.consensus;
    if (!c) {
      console.log(
        "\n! The reads disagreed, so this baseline is not a stable starting point.\n" +
          "  Re-run with --rebaseline once ESPN settles.",
      );
      process.exit(3);
    }
    if (c.drafted !== "true") {
      console.log(
        `\n! drafted=${c.drafted}, so this league's draft is NOT complete right now.\n` +
          "  The gate measures a completion being REVERSED and needs a completed draft\n" +
          "  to start from. Finish the draft, then re-run with --rebaseline.",
      );
      process.exit(3);
    }
    console.log(
      `\ndrafted=true with ${c.filledPicks} filled picks — a good starting point.\n\n` +
        "NEXT: reset the draft in ESPN (League → Settings → Draft → reset), then run\n" +
        "this exact command again. Nothing else needs to change.",
    );
    return;
  }

  // ---- RUN 2: compare ------------------------------------------------------
  console.log(
    `league ${league} (${season}) — comparing against the baseline of ${state.baseline.at} (run 2 of 2)\n`,
  );
  const latest = await runOnce(client, season, league, reads);
  await writeFile(statePath, `${JSON.stringify({ ...state, latest }, null, 2)}\n`);

  const before = state.baseline.consensus;
  const after = latest.consensus;
  if (!before || !after) {
    console.log(
      `\n${!before ? "The BASELINE's" : "This run's"} reads disagreed with each other, so there is nothing\n` +
        "trustworthy to compare. An ambiguous report voids nothing (FR-031f).\n" +
        (!before ? "Re-run with --rebaseline to take a fresh baseline." : "Re-run in a few minutes."),
    );
    process.exit(3);
  }

  table(before, after);
  const v = verdict(before, after);
  console.log(`\n${v.lines.join("\n")}`);
  console.log(
    "\nPaste-ready record for tasks.md T001:\n" +
      `  Gate run ${state.baseline.at.slice(0, 10)} -> ${latest.at.slice(0, 10)}, league ${league} (${season}), ` +
      `${reads} reads per run: drafted ${before.drafted} -> ${after.drafted}, ` +
      `filled picks ${before.filledPicks} -> ${after.filledPicks}. ` +
      `${v.pass ? "Flag flips back; US8 has its signal." : "See the verdict above."}`,
  );
  if (!v.pass) process.exit(3);
}

main().catch((e) => {
  console.error(e instanceof EspnError ? `ESPN error: ${e.code}` : `failed: ${(e as Error).message}`);
  process.exit(1);
});
