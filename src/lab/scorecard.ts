// 008 T033/T034/T035 — aggregate a run into something comparable.
//
// EVERY MEASURE HERE IS DESCRIPTIVE, NOT EVALUATIVE, and that is the single
// most important property of this file.
//
// The engine ranks by projected points. Any aggregate built from projected
// points therefore rewards whatever makes the engine agree more with its own
// input — and the entire rule layer exists BECAUSE projections alone are
// insufficient. A "roster strength" score would look like a clean improvement
// metric, would be available today, and would steer every tuning session in
// precisely the wrong direction.
//
// So: how far the ordering moved, where the engine disagreed with the pick that
// was made, how often each rule was decisive. None of it claims the engine was
// right. The one measure that could — actual season points — is a reserved,
// deliberately EMPTY slot until a season has been played (FR-017a), and it is
// never defaulted or approximated to fill the gap.

import { exclusionReason, isAdmissible, type CorpusEntry, type Fidelity } from "./corpus";
import { canonicalHash } from "./codec";
import type { TurnObservation } from "./replay";
import type { AdjustmentRule } from "../engine/types";
import * as CONSTANTS from "../engine/constants";

export const SCORECARD_FORMAT_VERSION = 1;

export interface RuleSetIdentity {
  /** Flattened tuning constants, e.g. `WEIGHT.bye`. */
  constants: Record<string, number>;
  /**
   * Content hash of `src/engine/*.ts`, COMPUTED BY THE CALLER.
   *
   * It cannot be computed here: `src/lab/**` is typechecked without node types
   * so there is no `node:fs`, and the run script executes under tsx where
   * `import.meta.glob` — a Vite build-time transform — does not exist. Neither
   * mechanism is available inside the pure core, which is exactly the mistake
   * `/speckit-analyze` caught in the first draft of the task list.
   *
   * It matters because a rule change that left the constants untouched would
   * otherwise be invisible: two scorecards would compare as though nothing had
   * changed.
   */
  engineVersion: string;
}

export interface BehaviouralMeasures {
  turnCount: number;
  /** Turns where the engine's first choice was the player actually taken. */
  headAgreementRate: number;
  /** Where the taken player sat in the engine's ordering, bucketed. */
  actualRankDistribution: { bucket: string; count: number }[];
  meanGapInRounds: number | null;
  medianGapInRounds: number | null;
  /** Per rule, how often it changed who came first. */
  decisiveRuleCounts: { rule: AdjustmentRule; count: number }[];
  forcedTurnCount: number;
  /** Turns whose drafted player was not on the board at all. */
  offBoardPickCount: number;
}

export interface OutcomeMeasures {
  season: number;
  actualPointsSource: string;
  ownerRosterActual: number;
  engineRosterActual: number | null;
}

export interface Scorecard {
  formatVersion: number;
  ruleSet: RuleSetIdentity;
  fidelity: Fidelity[];
  entries: { entryId: string; turns: TurnObservation[] }[];
  /** Named, never silently dropped. */
  excluded: { entryId: string; reason: string }[];
  behavioural: BehaviouralMeasures;
  /** NULL until the season has been played. Never defaulted. */
  outcome: OutcomeMeasures | null;
  hash: string;
}

/** Flatten `src/engine/constants.ts` into `path -> number`, sorted. */
export function flattenConstants(): Record<string, number> {
  const out: Record<string, number> = {};
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "number") {
      out[path] = value;
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        visit((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
    }
    // Arrays and strings are deliberately skipped: RELEVANCE maps a signal to
    // the positions it may move, which is a rule rather than a magnitude. It
    // still changes behaviour, which is what `engineVersion` is for.
  };
  for (const k of Object.keys(CONSTANTS).sort()) {
    visit((CONSTANTS as Record<string, unknown>)[k], k);
  }
  return out;
}

export interface ScoreInput {
  /** Every entry considered, admissible or not. */
  considered: { entry: CorpusEntry; fidelity: Fidelity; turns: TurnObservation[] | null }[];
  engineVersion: string;
}

export function buildScorecard(input: ScoreInput): Scorecard {
  const included: { entryId: string; turns: TurnObservation[] }[] = [];
  const excluded: { entryId: string; reason: string }[] = [];
  const fidelity: Fidelity[] = [];

  for (const c of input.considered) {
    const why = exclusionReason(c.entry);
    if (!isAdmissible(c.entry) || c.turns === null) {
      excluded.push({ entryId: c.entry.id, reason: why ?? "no turns produced" });
      continue;
    }
    included.push({ entryId: c.entry.id, turns: c.turns });
    fidelity.push(c.fidelity);
  }

  const turns = included.flatMap((e) => e.turns);
  const scorecard: Scorecard = {
    formatVersion: SCORECARD_FORMAT_VERSION,
    ruleSet: { constants: flattenConstants(), engineVersion: input.engineVersion },
    fidelity,
    entries: included.sort((a, b) => a.entryId.localeCompare(b.entryId)),
    excluded: excluded.sort((a, b) => a.entryId.localeCompare(b.entryId)),
    behavioural: behavioural(turns),
    // FR-017a. Reserved and EMPTY: the 2026 season has not been played, and
    // filling this with anything projection-derived would be the circularity
    // this whole file is built to avoid.
    outcome: null,
    hash: "",
  };
  // Hashed last, over everything else — so the hash covers the rule set and the
  // fidelity as well as the numbers.
  scorecard.hash = canonicalHash({ ...scorecard, hash: "" }, { round: 4 });
  return scorecard;
}

function behavioural(turns: readonly TurnObservation[]): BehaviouralMeasures {
  const gaps = turns.map((t) => t.gapInRounds).filter((g): g is number => g !== null);
  const ruleCounts = new Map<AdjustmentRule, number>();
  for (const t of turns) {
    if (t.decisiveRule) ruleCounts.set(t.decisiveRule, (ruleCounts.get(t.decisiveRule) ?? 0) + 1);
  }

  const agreed = turns.filter(
    (t) => t.engineHead !== null && t.engineHead.playerId === t.actualPlayerId,
  ).length;

  return {
    turnCount: turns.length,
    headAgreementRate: turns.length === 0 ? 0 : round4(agreed / turns.length),
    actualRankDistribution: rankBuckets(turns),
    meanGapInRounds: gaps.length === 0 ? null : round4(gaps.reduce((a, b) => a + b, 0) / gaps.length),
    medianGapInRounds: gaps.length === 0 ? null : round4(median(gaps)),
    decisiveRuleCounts: [...ruleCounts.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => a.rule.localeCompare(b.rule)),
    forcedTurnCount: turns.filter((t) => t.forced).length,
    offBoardPickCount: turns.filter((t) => t.actual === null).length,
  };
}

/** Buckets rather than a raw histogram: 300 ranks would be unreadable in a diff. */
const BUCKETS: [string, (rank: number) => boolean][] = [
  ["1", (r) => r === 1],
  ["2-3", (r) => r >= 2 && r <= 3],
  ["4-5", (r) => r >= 4 && r <= 5],
  ["6-10", (r) => r >= 6 && r <= 10],
  ["11-25", (r) => r >= 11 && r <= 25],
  ["26+", (r) => r >= 26],
];

function rankBuckets(turns: readonly TurnObservation[]): { bucket: string; count: number }[] {
  const counts = new Map<string, number>(BUCKETS.map(([b]) => [b, 0]));
  counts.set("off-board", 0);
  for (const t of turns) {
    if (t.actual === null) {
      counts.set("off-board", counts.get("off-board")! + 1);
      continue;
    }
    const hit = BUCKETS.find(([, test]) => test(t.actual!.rank));
    if (hit) counts.set(hit[0], counts.get(hit[0])! + 1);
  }
  // Fixed bucket order, not sorted by count: a diff should show the same rows
  // in the same places whatever the numbers did.
  return [...BUCKETS.map(([b]) => b), "off-board"].map((bucket) => ({
    bucket,
    count: counts.get(bucket)!,
  }));
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
