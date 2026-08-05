// 006 T023 — the five rule adjustments of FR-006.
//
// PURE. No platform imports, no clock.
//
// THEY DO NOT ALL COME FROM THE SAME PLACE, and an earlier draft of the
// research document was wrong to say they did. Three are 004 signals about a
// pro team, delivered in one uniform shape. Two are computed here, from the
// owner's roster and from the picks already made — they have NO
// `signal_entries` row and NO 0–100 score, so the signal formula cannot apply
// to them at all.
//
//   5a  offense, sos, oline   ((score − 50) / 50) × WEIGHT × relevance
//   5b  bye clash             severity against the position's starter slots
//   5c  positional run        observed share vs expected share, last N picks
//
// They share exactly one thing: the output currency. Every magnitude below is a
// fraction of ROUND_VALUE, so they compose additively and reconcile (FR-027).
//
// "NOT APPLICABLE" IS NOT "ZERO". O-line quality does not move a kicker, and
// emitting a zero adjustment would claim we looked and found nothing to say.
// The truth is the question does not arise, so no adjustment is emitted and
// nothing is reported missing. A signal that SHOULD apply but is unavailable is
// the other case, and that one is reported (FR-013).

import { RELEVANCE, WEIGHT } from "./constants";
import { normalisePosition } from "./value";
import type { Adjustment, MissingInput, RosteredPlayer, SignalKind, SignalValue } from "./types";
import type { BoardEntry } from "../projections/scoring";

const TEAM_SIGNALS: SignalKind[] = ["offense", "sos", "oline"];

const SIGNAL_NOUN: Record<SignalKind, string> = {
  offense: "offense",
  sos: "strength of schedule",
  oline: "offensive line",
};

export interface AdjustmentInput {
  player: BoardEntry;
  /** ESPN pro-team id, or undefined when the player is not joined to one. */
  proTeamId: number | undefined;
  signals: Map<SignalKind, Map<number, SignalValue>>;
  /** The owner's roster so far — drives the bye clash. */
  myRoster: readonly RosteredPlayer[];
  /** position → how many the league starts PER TEAM, from `computeBaselines`. */
  startersPerTeam: ReadonlyMap<string, number>;
  /** position → its share of all league-wide starter slots. */
  expectedShare: ReadonlyMap<string, number>;
  /** Positions of picks already made, oldest first. */
  recentPositions: readonly string[];
  teamCount: number;
  roundValue: number;
}

export interface AdjustmentResult {
  adjustments: Adjustment[];
  missing: MissingInput[];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function signed(rule: Adjustment["rule"], magnitude: number, reason: string): Adjustment {
  return { rule, magnitude: round2(magnitude), direction: magnitude >= 0 ? "up" : "down", reason };
}

/** Human wording for a 1–32 rank, so an explanation reads like a reason. */
function rankPhrase(kind: SignalKind, rank: number): string {
  const noun = SIGNAL_NOUN[kind];
  if (rank <= 5) return `top-5 ${noun}`;
  if (rank <= 10) return `top-10 ${noun}`;
  if (rank >= 28) return `bottom-5 ${noun}`;
  if (rank >= 23) return `bottom-10 ${noun}`;
  return `middling ${noun} (rank ${rank})`;
}

export function ruleAdjustments(i: AdjustmentInput): AdjustmentResult {
  const adjustments: Adjustment[] = [];
  const missing: MissingInput[] = [];
  const position = normalisePosition(i.player.position);
  if (i.roundValue <= 0) return { adjustments, missing };

  // --- 5a: the three team signals ------------------------------------------
  for (const kind of TEAM_SIGNALS) {
    // Not applicable to this position: emit nothing, report nothing.
    if (!RELEVANCE[kind].includes(position)) continue;

    const forKind = i.signals.get(kind);
    if (!forKind) {
      missing.push({ input: kind, detail: `no ${SIGNAL_NOUN[kind]} data is available at all` });
      continue;
    }
    const value = i.proTeamId === undefined ? undefined : forKind.get(i.proTeamId);
    if (!value) {
      missing.push({ input: kind, detail: `no ${SIGNAL_NOUN[kind]} rating for ${i.player.team}` });
      continue;
    }

    const magnitude = ((value.score - 50) / 50) * WEIGHT[kind] * i.roundValue;
    if (round2(magnitude) === 0) continue; // dead centre: nothing to say
    adjustments.push(signed(kind, magnitude, rankPhrase(kind, value.rank)));
  }

  // --- 5b: bye-week clash --------------------------------------------------
  if (i.player.bye_week === null) {
    missing.push({ input: "bye", detail: "bye week unknown for this player" });
  } else {
    const clashes = i.myRoster.filter(
      (r) => normalisePosition(r.position) === position && r.byeWeek === i.player.bye_week,
    ).length;
    if (clashes > 0) {
      // Divided by the position's STARTER slots, so the penalty is
      // proportionate: a second starting RB on the same bye is most of your
      // backfield that week; a third bench receiver barely registers.
      const starters = Math.max(1, i.startersPerTeam.get(position) ?? 1);
      const severity = Math.min(1, clashes / starters);
      adjustments.push(
        signed(
          "bye",
          -WEIGHT.bye * severity * i.roundValue,
          clashes === 1
            ? `bye week ${i.player.bye_week} clashes with your ${position}`
            : `bye week ${i.player.bye_week} clashes with ${clashes} of your ${position}s`,
        ),
      );
    }
  }

  // --- 5c: positional run --------------------------------------------------
  // Measured BACKWARD, from picks already made (FR-006). The forward-looking
  // counterpart is `survival` in adp.ts. With no picks yet there is no run to
  // detect, and that is an absence of evidence rather than a missing input.
  const window = Math.max(1, i.teamCount);
  const recent = i.recentPositions.slice(-window);
  if (recent.length > 0) {
    const expected = i.expectedShare.get(position) ?? 0;
    if (expected > 0) {
      const observed = recent.filter((p) => normalisePosition(p) === position).length / recent.length;
      const intensity = Math.max(-1, Math.min(1, (observed - expected) / Math.max(expected, 0.01)));
      const magnitude = WEIGHT.scarcity * intensity * i.roundValue;
      if (round2(magnitude) !== 0) {
        adjustments.push(
          signed(
            "scarcity",
            magnitude,
            intensity > 0
              ? `a run on ${position} — ${Math.round(observed * 100)}% of the last ${recent.length} picks`
              : `${position} is going slower than usual — ${Math.round(observed * 100)}% of the last ${recent.length} picks`,
          ),
        );
      }
    }
  }

  return { adjustments, missing };
}

/** position → its share of all league-wide starter slots, from the boundaries. */
export function expectedShares(boundary: ReadonlyMap<string, number>): Map<string, number> {
  let total = 0;
  for (const n of boundary.values()) total += n;
  const out = new Map<string, number>();
  if (total <= 0) return out;
  for (const [pos, n] of boundary) out.set(pos, n / total);
  return out;
}
