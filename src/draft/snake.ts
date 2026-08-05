// 005 T007 — snake order projection.
//
// PURE. Imports nothing from the platform, which is what makes FR-021 (offline
// replay) true by construction and keeps the Durable Object a thin shell.
//
// Two rules carry the whole module:
//
//  1. OBSERVED FACT BEATS PROJECTION. Below the frontier we use the team that
//     actually picked. ESPN's published order is a plan; a mid-draft change or
//     a traded pick makes the plan wrong, and a projection that overrides fact
//     produces a board that disagrees with the draft room the owner is looking
//     at.
//  2. UNKNOWN IS NOT ZERO. With no published order there is no honest
//     projection, so `picksUntilTurn` returns null and the UI shows a dash.
//     A countdown that is quietly wrong is worse than no countdown (FR-017).
//
// "Auction later" (ratified 2026-08-02) is why the serpentine lives here rather
// than inside the reducer: a second format replaces this module and nothing
// else.

export type OrderTrust = "observed" | "projected" | "unknown";

export interface ProjectionInput {
  /** Published draft order, team ids in round-1 sequence. Empty ⇒ unknown. */
  order: readonly number[];
  /** 1-based overall pick number. */
  overall: number;
  /** overall → team id, for picks actually seen. */
  observed: ReadonlyMap<number, number>;
}

/**
 * Which team holds pick `overall`?
 *
 * Observation first, then the serpentine projection, then null. Never a guess
 * dressed as an answer.
 */
export function teamAt(i: ProjectionInput): number | null {
  const seen = i.observed.get(i.overall);
  if (seen !== undefined) return seen;
  return projectTeamAt(i.order, i.overall);
}

/** The pure serpentine, with no observation. Exported for the schedule. */
function projectTeamAt(order: readonly number[], overall: number): number | null {
  const n = order.length;
  if (n === 0 || overall < 1) return null;
  const round = Math.ceil(overall / n); // 1-based
  const indexInRound = (overall - 1) % n;
  // Even rounds run backwards — the reversal that distinguishes a team id from
  // a pick number, and the property the US1 capture used to confirm field 1.
  const idx = round % 2 === 1 ? indexInRound : n - 1 - indexInRound;
  return order[idx] ?? null;
}

export interface TurnInput {
  order: readonly number[];
  /** Lowest pick number not yet made — the owner is "on the clock" at this. */
  frontier: number;
  myTeamId: number;
  observed: ReadonlyMap<number, number>;
  /** Total picks in the draft. Unbounded search stops here. */
  totalPicks?: number;
}

/**
 * How many picks until the owner's next turn? `0` means on the clock now.
 *
 * Returns **null** when the order is unknown, or when the owner has no turns
 * left. Both are honest absences and the UI must render them as such.
 */
export function picksUntilTurn(i: TurnInput): number | null {
  if (i.order.length === 0) return null;
  const limit = i.totalPicks ?? i.order.length * 64;
  for (let overall = i.frontier; overall <= limit; overall++) {
    const team = teamAt({ order: i.order, overall, observed: i.observed });
    if (team === i.myTeamId) return overall - i.frontier;
  }
  return null;
}

export interface ScheduleInput {
  order: readonly number[];
  frontier: number;
  myTeamId: number;
  totalPicks: number;
}

/** The owner's remaining pick numbers, in order. Empty when unknowable. */
export function remainingSchedule(i: ScheduleInput): number[] {
  if (i.order.length === 0) return [];
  const out: number[] = [];
  for (let overall = i.frontier; overall <= i.totalPicks; overall++) {
    if (projectTeamAt(i.order, overall) === i.myTeamId) out.push(overall);
  }
  return out;
}

/**
 * How much can the order be trusted?
 *
 * `observed` once the draft has produced enough picks to confirm the published
 * order, `projected` while it is only ESPN's plan, `unknown` with no order at
 * all — which degrades turn events and shows dashes rather than inventing a
 * schedule.
 */
export function orderTrust(order: readonly number[], observedCount: number): OrderTrust {
  if (order.length === 0) return "unknown";
  return observedCount >= order.length ? "observed" : "projected";
}
