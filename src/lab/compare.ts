// 008 T037 — two scorecards, same corpus: what actually moved.
//
// THE THRESHOLD IS FIXED HERE, in one exported constant, and reported in every
// comparison. That is not a detail. A threshold each run chooses for itself
// makes two reports silently incomparable — the movement that "appeared"
// between Tuesday and Friday would be a different bar, not a different engine —
// and a reader could not tell an unchanged turn from one that moved below the
// line.
//
// The other property this file owes the feature: when two runs under IDENTICAL
// rules disagree, that is a DETERMINISM FAILURE, not a rule effect. Reporting
// it as movement would be the worst possible outcome, because it arrives
// looking exactly like a finding.

import type { Scorecard } from "./scorecard";
import type { RuleSetIdentity } from "./scorecard";
import type { TurnObservation } from "./replay";

/**
 * Movement worth reporting.
 *
 * `rankMovement: 3` — a player shifting one or two places is inside the noise
 * of two adjacent values; three is the point at which a human reading the
 * shortlist would notice.
 * `valueInRounds: 0.1` — a tenth of a round. The whole rule layer is capped at
 * about one round, so this is roughly a tenth of the total headroom.
 *
 * First estimates, like 006's own constants, and revisable — but revisable in
 * ONE place, with every report saying which bar it applied.
 */
export const DEFAULT_THRESHOLD = { rankMovement: 3, valueInRounds: 0.1 } as const;

export interface Threshold {
  rankMovement: number;
  valueInRounds: number;
}

export interface HeadChange {
  entryId: string;
  overall: number;
  from: { playerId: number; name: string } | null;
  to: { playerId: number; name: string } | null;
  deltaInRounds: number | null;
}

export interface Movement {
  entryId: string;
  overall: number;
  maxRankDelta: number;
  valueDeltaInRounds: number;
}

export interface Comparison {
  baseline: RuleSetIdentity;
  candidate: RuleSetIdentity;
  /** Stated, always — so an unchanged turn is distinguishable from a quiet one. */
  threshold: Threshold;
  headChanges: HeadChange[];
  movements: Movement[];
  aggregateDeltas: {
    headAgreementRate: number;
    meanGapInRounds: number | null;
    turnCount: number;
  };
  /**
   * True when the two runs used the same rules and still disagreed.
   *
   * Every comparison in this feature is worthless until this is false, which is
   * why it is a named field rather than an inference left to the reader.
   */
  determinismFailure: boolean;
  /** Entries present in one scorecard and not the other. */
  corpusMismatch: string[];
}

export function compareScorecards(
  baseline: Scorecard,
  candidate: Scorecard,
  threshold: Threshold = DEFAULT_THRESHOLD,
): Comparison {
  const sameRules =
    canonicalRuleSet(baseline.ruleSet) === canonicalRuleSet(candidate.ruleSet);

  const baseEntries = new Map(baseline.entries.map((e) => [e.entryId, e.turns]));
  const candEntries = new Map(candidate.entries.map((e) => [e.entryId, e.turns]));

  const corpusMismatch = [
    ...[...baseEntries.keys()].filter((id) => !candEntries.has(id)),
    ...[...candEntries.keys()].filter((id) => !baseEntries.has(id)),
  ].sort();

  const headChanges: HeadChange[] = [];
  const movements: Movement[] = [];

  for (const [entryId, baseTurns] of baseEntries) {
    const candTurns = candEntries.get(entryId);
    if (!candTurns) continue;
    const byOverall = new Map(candTurns.map((t) => [t.overall, t]));

    for (const before of baseTurns) {
      const after = byOverall.get(before.overall);
      if (!after) continue;

      const fromId = before.engineHead?.playerId ?? null;
      const toId = after.engineHead?.playerId ?? null;
      if (fromId !== toId) {
        headChanges.push({
          entryId,
          overall: before.overall,
          from: before.engineHead ? { playerId: before.engineHead.playerId, name: before.engineHead.name } : null,
          to: after.engineHead ? { playerId: after.engineHead.playerId, name: after.engineHead.name } : null,
          deltaInRounds: deltaInRounds(before, after),
        });
      }

      const movement = movementOf(before, after);
      if (
        movement.maxRankDelta >= threshold.rankMovement ||
        Math.abs(movement.valueDeltaInRounds) >= threshold.valueInRounds
      ) {
        movements.push({ entryId, overall: before.overall, ...movement });
      }
    }
  }

  const changed = headChanges.length > 0 || movements.length > 0;

  return {
    baseline: baseline.ruleSet,
    candidate: candidate.ruleSet,
    threshold,
    headChanges: headChanges.sort((a, b) => a.entryId.localeCompare(b.entryId) || a.overall - b.overall),
    movements: movements.sort((a, b) => a.entryId.localeCompare(b.entryId) || a.overall - b.overall),
    aggregateDeltas: {
      headAgreementRate: round4(
        candidate.behavioural.headAgreementRate - baseline.behavioural.headAgreementRate,
      ),
      meanGapInRounds:
        candidate.behavioural.meanGapInRounds === null || baseline.behavioural.meanGapInRounds === null
          ? null
          : round4(candidate.behavioural.meanGapInRounds - baseline.behavioural.meanGapInRounds),
      turnCount: candidate.behavioural.turnCount - baseline.behavioural.turnCount,
    },
    // Same rules, different answers. Not a finding — a fault.
    determinismFailure: sameRules && changed,
    corpusMismatch,
  };
}

/** True when a comparison found nothing at all. */
export function isEmpty(c: Comparison): boolean {
  return c.headChanges.length === 0 && c.movements.length === 0;
}

/**
 * How far the shortlist moved between two runs of the same turn.
 *
 * Rank movement is measured over the SHORTLIST rather than the whole board: a
 * player at rank 400 sliding to 403 is not a rule effect anyone can act on, and
 * including it would bury the changes at the top that matter.
 */
function movementOf(
  before: TurnObservation,
  after: TurnObservation,
): { maxRankDelta: number; valueDeltaInRounds: number } {
  const beforeRanks = new Map(before.shortlist.map((s, i) => [s.playerId, i]));
  let maxRankDelta = 0;
  after.shortlist.forEach((s, i) => {
    const was = beforeRanks.get(s.playerId);
    // A player who was not in the shortlist before and is now counts as having
    // moved by the shortlist's whole length — otherwise the most dramatic
    // change possible would register as zero.
    const delta = was === undefined ? before.shortlist.length : Math.abs(was - i);
    if (delta > maxRankDelta) maxRankDelta = delta;
  });

  return { maxRankDelta, valueDeltaInRounds: deltaInRounds(before, after) ?? 0 };
}

function deltaInRounds(before: TurnObservation, after: TurnObservation): number | null {
  if (!before.engineHead || !after.engineHead) return null;
  const rv = after.roundValue || before.roundValue;
  if (!rv) return null;
  return round4((after.engineHead.finalValue - before.engineHead.finalValue) / rv);
}

function canonicalRuleSet(r: RuleSetIdentity): string {
  const keys = Object.keys(r.constants).sort();
  return `${r.engineVersion}|${keys.map((k) => `${k}=${r.constants[k]}`).join(",")}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
