// 006 T004 — the engine's argument and return shapes.
//
// PURE. No platform imports. See `tests/engine/purity.test.ts`, which enforces
// that for every file in this directory with NO exemptions — which is why the
// D1 bundle loader lives at `src/db/engineBundle.ts` and not here.
//
// The split below is the design in one line: `EngineBundle` is the SLOW half
// (board, signals, league settings — changes on the projection refresh
// cadence), `EngineState` is the FAST half (changes every pick). Keeping them
// apart is what would let a cache be added later in front of the bundle
// without touching a rule; none is added now (Constitution VIII).

import type { BoardEntry } from "../projections/scoring";
import type { RosterSnapshot } from "../espn/parsers";

/** 004's uniform per-team signal shape, restated so this file imports no db module. */
export interface SignalValue {
  raw_value: number;
  score: number;
  rank: number;
  provenance: string;
  computed_at: string;
}

export type SignalKind = "offense" | "sos" | "oline";

/** Everything that changes on the projection cadence rather than per pick. */
export interface EngineBundle {
  /** League-scored, from 002/003. Already carries `adp` and `bye_week`. */
  players: BoardEntry[];
  /** kind → proTeamId → value. Absent kinds and absent teams both mean "unknown". */
  signals: Map<SignalKind, Map<number, SignalValue>>;
  /** espn_player_id → pro team, so a candidate can be joined to its signals. */
  proTeamByPlayer: Map<number, number>;
  roster: RosterSnapshot;
  teamCount: number;
  /** The owner's marked players. Empty is the norm, not an error. */
  preferred: Set<number>;
  /**
   * ESPN's ADP saturation floor for the serving projection set, or null if none
   * was detectable. An ADP at or above this is treated as ABSENT (FR-022).
   */
  adpFloor: number | null;
  freshness: { fetchedAt: string; stale: boolean };
  /** kind → when it was computed, for the explanation's `missing` notes. */
  signalFreshness: Map<SignalKind, { computedAt: string; provenance: string }>;
}

/** One roster spot already committed, for bye-clash and needs arithmetic. */
export interface RosteredPlayer {
  playerId: number;
  position: string;
  byeWeek: number | null;
}

/** Everything that changes per pick. Derived from 005's session snapshot. */
export interface EngineState {
  /** Stamped on the output. A consumer holding an older one must discard (FR-016). */
  revision: number;
  /** The pick number now on the clock — 005's frontier. */
  currentOverall: number;
  /**
   * Every player who cannot be taken: confirmed picks, pending picks, AND
   * keepers on any team. See `state.ts` for why all three.
   */
  drafted: Set<number>;
  /** Kept players, across all teams. Already included in `drafted`. */
  keepers: Set<number>;
  /** The owner's own picks and keepers. */
  myRoster: RosteredPlayer[];
  /**
   * Picks between now and the owner's next turn.
   *
   * NULL means there is no next turn — the owner's final pick. Survival does
   * not apply and its absence is NOT a missing signal (FR-023). 005's
   * `picksUntilTurn()` already returns null for this, correctly.
   */
  gapToNextTurn: number | null;
  /** How many picks the owner still has, including this one. Drives FR-025. */
  myRemainingPicks: number;
  /** The positions of picks already made, newest last — drives run detection. */
  recentPositions: string[];
  /** 005's verdict. Non-null means withhold and say why (FR-012). */
  withholding: { reason: string; detail: string } | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type AdjustmentRule =
  | "offense"
  | "sos"
  | "oline"
  | "bye"
  | "scarcity"
  | "slot_value"
  | "survival"
  | "preferred";

/**
 * One rule's effect on one player.
 *
 * `direction` is redundant with the sign of `magnitude`, and deliberately so: a
 * display should not have to infer which way a number pushed.
 */
export interface Adjustment {
  rule: AdjustmentRule;
  /** SIGNED, in the league's own value currency (FR-027). */
  magnitude: number;
  direction: "up" | "down";
  /** The named cause — "top-5 offense", not a bare score (Constitution VII). */
  reason: string;
}

export interface MissingInput {
  input: string;
  detail: string;
}

export interface Explanation {
  rawValue: number;
  finalValue: number;
  /** The unit every magnitude above is a fraction of. */
  roundValue: number;
  /** EMPTY means no rule fired — said plainly, never omitted (US2 AS3). */
  adjustments: Adjustment[];
  missing: MissingInput[];
  alternatives: { playerId: number; name: string; finalValue: number }[];
  /** Set when FR-025 forced this pick rather than the engine choosing it. */
  forcedBy: string | null;
}

export interface RankedEntry {
  playerId: number;
  name: string;
  position: string;
  team: string;
  rank: number;
  rawValue: number;
  finalValue: number;
  /**
   * Duplicated from the explanation on purpose: a display must be able to badge
   * a player BELOW the shortlist head without fetching an explanation (FR-026).
   */
  preferred: boolean;
}

export interface Recommendation extends RankedEntry {
  explanation: Explanation;
}

export type WarningKind =
  | "board_stale"
  | "signals_missing"
  | "mandatory_unfilled"
  | "mandatory_unsatisfiable"
  | "order_unknown";

export interface Warning {
  kind: WarningKind;
  detail: string;
}

export interface RankedBoard {
  revision: number;
  /** When set, `entries` and `shortlist` are both empty (FR-012). */
  withheld: { reason: string; detail: string } | null;
  /** True once every remaining pick is mandated (FR-025). */
  forced: boolean;
  roundValue: number;
  warnings: Warning[];
  /** The head, with full explanations. */
  shortlist: Recommendation[];
  /** EVERY available player, ordered. Value and rank only (FR-001). */
  entries: RankedEntry[];
}
