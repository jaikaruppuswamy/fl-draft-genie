// 006 T005 — every tunable magnitude in the engine, in one file.
//
// This file exists so that the later rule-tuning session (ROADMAP) has exactly
// ONE place to open. A magnitude hardcoded inside a rule defeats that, so none
// is: every number the engine multiplies by lives here.
//
// These are NOT settings. Constitution IV: the rule set is code, not config.
// Nothing here is reachable from an endpoint, a column or a page, and
// `tests/engine/purity.test.ts` asserts that structurally.
//
// THE UNIT. Every adjustment is expressed as a fraction of `ROUND_VALUE` — the
// value an owner gives up by waiting one full round, measured on the current
// available board (see `value.ts`). That is what makes one set of numbers mean
// the same thing in a 10-team standard league and a 14-team PPR one, which a
// flat point constant could never do (Constitution II and III).

/** How many players get a full explanation. The answer to "who now?" (FR-001). */
export const SHORTLIST_SIZE = 5;

/**
 * Weights for the five rule adjustments, in `ROUND_VALUE` units.
 *
 * Every one is under half a round, and their plausible maximum sum (~1.4)
 * is roughly one round. That ceiling is the point: rules should break a tie or
 * move a player a round, never overturn the value ranking outright. Value is
 * the product; the rules are seasoning.
 *
 * First estimates, chosen for the right order of magnitude and the right
 * RELATIVE ordering. Scoring them against outcomes is 008's job.
 */
export const WEIGHT = {
  /** Broadest signal — applies to every offensive position, including K. */
  offense: 0.3,
  /** Real, but noisy this far out from the season. */
  sos: 0.2,
  /** Curated (PFF), and the most position-specific of the three. */
  oline: 0.25,
  /** A bye clash is concrete rather than forecast, so it outweighs the rest. */
  bye: 0.35,
  /** Observed from the draft itself, not predicted. */
  scarcity: 0.3,
} as const;

export type WeightKind = keyof typeof WEIGHT;

/**
 * Which positions each TEAM signal is allowed to move (research §5a).
 *
 * A signal that does not apply produces NO adjustment, which is different from
 * a zero one — the explanation says so (FR-013). O-line quality does not move a
 * kicker, and pretending it does with a zero would claim we looked.
 */
export const RELEVANCE: Record<"offense" | "sos" | "oline", readonly string[]> = {
  offense: ["QB", "RB", "WR", "TE", "K"],
  sos: ["QB", "RB", "WR", "TE", "K", "DST", "D/ST"],
  oline: ["RB", "QB"],
};

/**
 * The preferred-player cap, in `ROUND_VALUE` units (FR-007).
 *
 * 1.0 means "you may reach up to about one round early for a player you want".
 * Bounded by construction: a player whose raw value trails the leader by more
 * than one round's worth can never be lifted to the top (SC-006).
 */
export const PREFERRED_CAP = 1.0;

/**
 * Ceiling on the COMBINED magnitude of the two ADP-derived rules (research §4).
 *
 * `slot_value` and `survival` read the same column and answer different
 * questions, so both are legitimate — but a player who has fallen past his ADP
 * AND will not last to the next turn would otherwise be paid twice for one
 * fact. Their sum is clamped here, and `tests/engine/adp.test.ts` asserts it by
 * constructing exactly that player.
 */
export const ADP_COMBINED_CAP = 0.75;

/**
 * How much denser than the median a band must be to count as ESPN's ADP floor
 * (research §3).
 *
 * NOT load-bearing, and deliberately so. Production measurement 2026-08-05:
 * about 1 player per ADP unit below 150, versus about 125 per unit in the
 * 169–171.6 band — a separation of roughly 100x. Any ratio between 5 and 50
 * finds the same boundary, which is what `tests/engine/adp-floor.test.ts`
 * asserts. Hardcoding 169.9 was rejected because it is THIS season's number.
 */
export const FLOOR_DENSITY_RATIO = 10;

/** How many alternatives an explanation names (FR-009). */
export const ALTERNATIVES_SHOWN = 3;
