// 011 US8 — deciding whether ESPN is telling us a draft was reset.
//
// A pure module, because the output is "destroy every manager's board for this
// league", and that is not a decision to leave inline in a sync routine where
// nothing can test it.
//
// THE MEASUREMENT THAT SHAPES ALL OF THIS (011 T001, run against a real league
// on 2026-08-07, `scripts/gate-draft-reset.ts`):
//
//   * `drafted` really does return to `false` after a reset;
//   * a reset REBUILDS the pick skeleton rather than shortening it —
//     `picks.length` stayed 72 while filled picks went 72 → 0, every
//     `playerId` back to -1;
//   * a reset clears ESPN's draft date.
//
// AND THE THING THAT NEARLY MADE THIS UNSAFE. `tests/fixtures/espn/draft/open.json`
// is a capture of a draft that is RUNNING RIGHT NOW: `drafted: false`,
// 72 rows, 0 filled. It is indistinguishable from a post-reset body on every
// field except `inProgress`. So "drafted is false and nothing is filled" — the
// obvious rule, and the one this task's own description suggests — voids a live
// draft. Under league-shared delivery that wipes every manager's board at once,
// mid-draft.
//
// What separates them is MEMORY: did ESPN itself previously tell us this draft
// was complete? A live draft that has never finished has no such memory. That
// is FR-031a1's "key on a change in ESPN's own report" read literally, and it
// is load-bearing rather than stylistic.

/** ESPN's placeholder in a rebuilt draft board. */
export const SKELETON_PLAYER_ID = -1;

/**
 * Picks that actually name a player.
 *
 * NEVER a sign test. D/ST player ids are legitimately negative — around -16000 —
 * and `playerId > 0` is precisely what made 010's capture report 66 of 72 picks
 * for a complete draft. Only the exact skeleton value is excluded.
 *
 * `parseCompletedDraft` cannot be reused here: it deliberately admits `-1` rows
 * so a partially-drafted board still parses, which means it returns 72 for a
 * fully reset draft and the corroboration would never fire.
 */
export function filledPickCount(picks: readonly { playerId?: unknown }[]): number {
  let n = 0;
  for (const p of picks) if (Number(p.playerId) !== SKELETON_PLAYER_ID) n++;
  return n;
}

/** What we remember ESPN having said, and what it is saying now. */
export interface ResetInput {
  /**
   * When ESPN itself first reported this draft complete, or null.
   *
   * MONOTONIC and stored separately from the snapshot on purpose. The snapshot
   * is overwritten by the very sync that would notice the change, so comparing
   * against it is a race with its own writer — and a sync that declines to void
   * would consume the evidence, making the transition unobservable forever.
   */
  espnCompletedAt: string | null;
  /** A previous sync already saw a qualifying observation, or null. */
  suspectedAt: string | null;
  /** The raw `draftDetail`, UNPARSED. See `report` below for why. */
  draftDetail: unknown;
  /** Does this response describe the league and season we asked about? */
  identityMatches: boolean;
  /** Is any session for this league currently live? Never void one (FR-031d). */
  anyLive: boolean;
  /** Is a completed draft still waiting to be archived? Defer rather than void. */
  awaitingArchive: boolean;
  /** Draft types other than snake are unmeasured — see `unsupported_draft_type`. */
  supportedDraftType: boolean;
  now: string;
}

export type ResetOutcome =
  | { kind: "void"; reason: "espn_reset_idle" | "espn_reset_redrafting"; observedFilled: number; rows: number }
  | { kind: "suspect" }
  | { kind: "ignore"; why: IgnoreReason };

export type IgnoreReason =
  | "no_memory"
  | "identity_mismatch"
  | "no_draft_detail"
  | "drafted_absent"
  | "still_drafted"
  | "in_progress_absent"
  | "no_picks_array"
  | "picks_still_filled"
  | "draft_is_live"
  | "awaiting_archive"
  | "unsupported_draft_type";

/**
 * Read the raw body rather than the parsed league.
 *
 * `parseLeague` writes `completed: res.draftDetail?.drafted ?? false`, which
 * collapses "ESPN did not tell us" into "ESPN said no". FR-031f requires an
 * unavailable or ambiguous report to void NOTHING, so the ambiguity has to
 * survive to the decision — and through the parser it cannot.
 */
function report(dd: unknown): { drafted?: boolean; inProgress?: boolean; picks?: { playerId?: unknown }[] } | null {
  if (dd === null || typeof dd !== "object") return null;
  return dd as { drafted?: boolean; inProgress?: boolean; picks?: { playerId?: unknown }[] };
}

/**
 * Every condition is required, and the order is the order of certainty.
 *
 * A reset is confirmed only on the SECOND qualifying observation. Production
 * reads ESPN once per sync; the gate needed three reads before it would call a
 * report unambiguous. One observation raises a suspicion, a later one confirms
 * it, and any non-qualifying observation clears it — so replica lag or a
 * one-off oddity cannot void anything, and it costs no extra ESPN reads.
 */
export function classifyReset(i: ResetInput): ResetOutcome {
  // Memory first. Without it this is a draft ESPN never told us had finished,
  // and the live-draft fixture proves that shape is otherwise identical.
  if (i.espnCompletedAt === null) return { kind: "ignore", why: "no_memory" };
  if (!i.identityMatches) return { kind: "ignore", why: "identity_mismatch" };
  if (!i.supportedDraftType) return { kind: "ignore", why: "unsupported_draft_type" };

  // Refuse before reading the body at all. A void moves the session's log floor
  // to the current tip, so voiding the wrong thing is not recoverable — the
  // frames survive but no session can reach them again.
  if (i.anyLive) return { kind: "ignore", why: "draft_is_live" };
  if (i.awaitingArchive) return { kind: "ignore", why: "awaiting_archive" };

  const dd = report(i.draftDetail);
  if (!dd) return { kind: "ignore", why: "no_draft_detail" };
  if (typeof dd.drafted !== "boolean") return { kind: "ignore", why: "drafted_absent" };
  if (dd.drafted) return { kind: "ignore", why: "still_drafted" };
  // Presence required, because the VALUE chooses the reason below.
  if (typeof dd.inProgress !== "boolean") return { kind: "ignore", why: "in_progress_absent" };
  // An empty array is a partial view, not an emptied board — a published-but-
  // unstarted draft looks exactly like that.
  if (!Array.isArray(dd.picks) || dd.picks.length === 0) return { kind: "ignore", why: "no_picks_array" };

  const filled = filledPickCount(dd.picks);
  if (filled > 0) return { kind: "ignore", why: "picks_still_filled" };

  if (i.suspectedAt === null) return { kind: "suspect" };

  return {
    kind: "void",
    // Kept apart so that when one of them is ever wrong, the first question is
    // which one fired — the same argument as `RejectedLedger`'s two reasons.
    //
    // `redrafting` is the more urgent of the two: ESPN cannot run a draft in a
    // league it previously reported complete unless it was reset, and those
    // sessions are already contaminated — they hold a completion stamp from the
    // first draft, so they can never report live again.
    reason: dd.inProgress ? "espn_reset_redrafting" : "espn_reset_idle",
    observedFilled: filled,
    rows: dd.picks.length,
  };
}
