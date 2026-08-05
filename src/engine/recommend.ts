// 006 T026 — the engine contract.
//
//     recommend(bundle, state) → RankedBoard
//
// PURE. No `Date`, no `Env`, no `D1Database`, no network, no randomness. That
// is not a coding style; it is what makes "runs offline against an archived
// draft" (FR-014, SC-009) and "reproducible from the archive alone" (SC-010)
// properties of the TYPE SIGNATURE rather than promises about behaviour.
// `tests/engine/purity.test.ts` enforces it structurally.
//
// Three properties are contractual (contracts/api.md §1):
//
//   1. Determinism  — same arguments, identical output, byte for byte.
//   2. Totality     — every available player ordered, no tie left unresolved.
//   3. Reconciliation — each explanation's magnitudes sum to its value delta.

import { adpAdjustments } from "./adp";
import { expectedShares, ruleAdjustments } from "./adjustments";
import { SHORTLIST_SIZE } from "./constants";
import { alternativesFor, explain, finalValueOf } from "./explain";
import { preferredAdjustment } from "./preferred";
import { fillsNeed, mandatoryWarning, rosterStatus } from "./roster";
import { adpIsUsable } from "../projections/adpFloor";
import { computeBaselines, normalisePosition, roundValue, valueOf } from "./value";
import type {
  Adjustment,
  EngineBundle,
  EngineState,
  MissingInput,
  RankedBoard,
  RankedEntry,
  Recommendation,
  Warning,
} from "./types";

/** One player, fully scored, before the ordering is known. */
interface Scored extends RankedEntry {
  adjustments: Adjustment[];
  missing: MissingInput[];
  forcedBy: string | null;
  /** Null for an unprojected player — they sort behind everyone with a value. */
  hasValue: boolean;
}

/** The whole computation, once. Both public entry points read from this. */
interface ScoredBoard {
  ordered: Scored[];
  entries: RankedEntry[];
  round: number;
  status: ReturnType<typeof rosterStatus>;
  warnings: Warning[];
}

function scoreBoard(bundle: EngineBundle, state: EngineState): ScoredBoard {
  const baselines = computeBaselines(bundle.players, bundle.roster, bundle.teamCount);
  const shares = expectedShares(baselines.boundary);
  const status = rosterStatus(bundle.roster, state.myRoster, state.myRemainingPicks);

  // FR-002: available means not drafted, not pending, and not kept — on any
  // team. `state.drafted` already unions all three; see `state.ts`.
  const available = bundle.players.filter((p) => !state.drafted.has(p.espn_player_id));

  // ROUND_VALUE is measured on what is ACTUALLY left, so it shrinks as the
  // board flattens and every adjustment shrinks with it.
  const rawValues = available
    .map((p) => valueOf(p, baselines))
    .filter((v): v is number => v !== null)
    .sort((a, b) => b - a);
  const round = roundValue(rawValues, bundle.teamCount);

  const scored: Scored[] = available.map((p) => {
    const position = normalisePosition(p.position);
    const raw = valueOf(p, baselines);
    const adjustments: Adjustment[] = [];
    const missing: MissingInput[] = [];

    // An unprojected player has no value to adjust. Running the rules over
    // nothing would produce adjustments against a phantom baseline.
    if (raw !== null) {
      const rules = ruleAdjustments({
        player: p,
        proTeamId: bundle.proTeamByPlayer.get(p.espn_player_id),
        signals: bundle.signals,
        myRoster: state.myRoster,
        startersPerTeam: baselines.startersPerTeam,
        expectedShare: shares,
        recentPositions: state.recentPositions,
        teamCount: bundle.teamCount,
        roundValue: round,
      });
      adjustments.push(...rules.adjustments);
      missing.push(...rules.missing);

      // A FLOORED ADP is an ABSENT ADP (FR-022). 62% of the projected pool sits
      // at ESPN's saturation floor, and passing those values through would let
      // survival mark two thirds of the board as safely lasting.
      const usableAdp = adpIsUsable(p.adp, bundle.adpFloor) ? p.adp : null;
      const adp = adpAdjustments({
        adp: usableAdp,
        currentOverall: state.currentOverall,
        gapToNextTurn: state.gapToNextTurn,
        teamCount: bundle.teamCount,
        roundValue: round,
      });
      adjustments.push(...adp.adjustments);
      if (adp.missingAdp) {
        missing.push({
          input: "adp",
          detail:
            p.adp === null
              ? "no average draft position for this player"
              : "average draft position is at ESPN's floor, so it says nothing",
        });
      }

      const boost = preferredAdjustment(bundle.preferred.has(p.espn_player_id), round);
      if (boost) adjustments.push(boost);
    }

    const rawOrZero = raw ?? 0;
    return {
      playerId: p.espn_player_id,
      name: p.name,
      position,
      team: p.team,
      rank: 0, // assigned once ordered
      rawValue: Math.round(rawOrZero * 100) / 100,
      finalValue: raw === null ? Number.NEGATIVE_INFINITY : finalValueOf(rawOrZero, adjustments),
      preferred: bundle.preferred.has(p.espn_player_id),
      adjustments,
      missing,
      forcedBy: null,
      hasValue: raw !== null,
    };
  });

  // FR-025: once every remaining pick is forced, only players filling a
  // mandatory slot may head the list. Note this reorders the HEAD, it does not
  // remove anyone — `entries` still contains the whole pool (FR-001).
  if (status.forced) {
    for (const s of scored) {
      if (fillsNeed(s.position, status)) {
        s.forcedBy = `every remaining pick is forced — ${[...status.neededPositions].sort().join(", ")} still unfilled`;
      }
    }
  }

  const ordered = scored.sort((a, b) => {
    // Forced positions first, and only when forced.
    if (status.forced) {
      const af = a.forcedBy !== null ? 1 : 0;
      const bf = b.forcedBy !== null ? 1 : 0;
      if (af !== bf) return bf - af;
    }
    // Valued players always ahead of unprojected ones.
    if (a.hasValue !== b.hasValue) return a.hasValue ? -1 : 1;
    if (b.finalValue !== a.finalValue) return b.finalValue - a.finalValue;
    // TOTAL ORDER (FR-017). Name first so the board reads sensibly, then the
    // id, which is unique — so two players equal on every input still order
    // deterministically and the output is byte-identical between runs.
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.playerId - b.playerId;
  });

  const entries: RankedEntry[] = ordered.map((s, k) => ({
    playerId: s.playerId,
    name: s.name,
    position: s.position,
    team: s.team,
    rank: k + 1,
    rawValue: s.rawValue,
    finalValue: s.hasValue ? s.finalValue : 0,
    preferred: s.preferred,
  }));

  return { ordered, entries, round, status, warnings: buildWarnings(bundle, status) };
}

/**
 * Build the full explanation for one already-scored player.
 *
 * There is exactly ONE of these, used both for the shortlist head and for the
 * on-demand explanation of a player far down the board. A second path would be
 * free to drift, and the drift would be invisible — two explanations of the
 * same player that disagree.
 */
function recommendationAt(board: ScoredBoard, index: number): Recommendation {
  const s = board.ordered[index]!;
  const e = explain({
    rawValue: s.rawValue,
    roundValue: board.round,
    adjustments: s.adjustments,
    missing: s.missing,
    forcedBy: s.forcedBy,
  });
  e.alternatives = alternativesFor(board.entries, index);
  return { ...board.entries[index]!, explanation: e };
}

export function recommend(bundle: EngineBundle, state: EngineState): RankedBoard {
  // FR-012: a known-stale draft state means picks are provably being missed.
  // Ranking against it would be worse than saying nothing, so we say nothing —
  // and say why. This is a successful answer to the question, not an error.
  if (state.withholding) {
    return {
      revision: state.revision,
      withheld: state.withholding,
      forced: false,
      roundValue: 0,
      warnings: [],
      shortlist: [],
      entries: [],
    };
  }

  const board = scoreBoard(bundle, state);
  const headSize = Math.min(SHORTLIST_SIZE, board.ordered.length);
  const shortlist: Recommendation[] = [];
  for (let k = 0; k < headSize; k++) shortlist.push(recommendationAt(board, k));

  return {
    revision: state.revision,
    withheld: null,
    forced: board.status.forced,
    roundValue: Math.round(board.round * 100) / 100,
    warnings: board.warnings,
    shortlist,
    entries: board.entries,
  };
}

/**
 * The on-demand explanation for any available player (FR-009).
 *
 * Because the engine is deterministic, this returns exactly what the shortlist
 * would have said had the player been in the head — which is what lets 008
 * interrogate a player the owner actually took, without the engine emitting an
 * explanation per player per pick.
 */
export function explainPlayer(
  bundle: EngineBundle,
  state: EngineState,
  playerId: number,
): Recommendation | null {
  if (state.withholding) return null;
  const board = scoreBoard(bundle, state);
  const index = board.entries.findIndex((e) => e.playerId === playerId);
  if (index === -1) return null;
  return recommendationAt(board, index);
}

function buildWarnings(bundle: EngineBundle, status: ReturnType<typeof rosterStatus>): Warning[] {
  const warnings: Warning[] = [];

  // A stale BOARD is surfaced, never withheld — the distinction US4 had to be
  // corrected on. Stale projections still rank meaningfully; a stale DRAFT
  // STATE does not, and that is the case handled at the top of `recommend`.
  if (bundle.freshness.stale) {
    warnings.push({
      kind: "board_stale",
      detail: `projections were last refreshed ${bundle.freshness.fetchedAt}`,
    });
  }

  const absent = (["offense", "sos", "oline"] as const).filter((k) => !bundle.signals.has(k));
  if (absent.length > 0) {
    warnings.push({
      kind: "signals_missing",
      detail: `no data for: ${absent.join(", ")}`,
    });
  }

  if (status.unsatisfiable) {
    warnings.push({
      kind: "mandatory_unsatisfiable",
      detail: `${status.unfilledMandatory} mandatory slots unfilled but only ${status.remainingPicks} picks left — the roster cannot be completed`,
    });
  } else {
    const w = mandatoryWarning(status);
    if (w) warnings.push({ kind: "mandatory_unfilled", detail: w });
  }

  return warnings;
}
