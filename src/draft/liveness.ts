// 005 T011 — is the tap alive, and should we still be advising? (FR-007c/e/f)
//
// PURE. No platform imports.
//
// WHY LIVENESS IS A HEARTBEAT, NOT SILENCE. Pick silence is not evidence.
// Measured across two real drafts: ~1 second between autodrafted picks, and
// 90 s+ between human ones in the same league. No silence threshold separates
// a slow draft from a dead tap, and both errors are expensive — a false alarm
// during a slow round destroys trust in the indicator, and a missed one is the
// silent failure FR-017 exists to forbid.
//
// WHY TWO THRESHOLDS. A hidden tab's timers are throttled to roughly one per
// minute (010 research §"Gotchas": 1/second, then 1/minute after five chained
// timers with the tab hidden five minutes). The ratified design EXPECTS the
// draft-room tab to be hidden — the tap runs where the draft room is open, the
// UI runs wherever the owner is looking — so a single threshold sized for a
// visible tab would mark a healthy backgrounded tap dead on essentially every
// draft. The tap cannot defeat the throttling; it can only report that it is
// subject to it, which is why `hidden` rides along on every heartbeat.

/** Lapse threshold while the tap's tab is visible: three 15 s intervals. */
export const LAPSE_VISIBLE_MS = 45_000;

/** Lapse threshold while it is hidden, where timers stretch to ~1/minute. */
export const LAPSE_HIDDEN_MS = 150_000;

/** Tap states as reported by 010's status channel. */
export type TapReportedState =
  | "not-paired"
  | "paired"
  | "not-a-draft-page"
  | "watching"
  | "relaying"
  | "buffering"
  | "version-rejected"
  | "incompatible"
  | "draft-finished"
  | "draft-end-unknown";

export interface LivenessInput {
  /** Epoch ms of the last heartbeat, or null if none has ever arrived. */
  lastHeartbeatAt: number | null;
  /** Whether the tap reported its tab hidden on that heartbeat. */
  hidden: boolean;
  now: number;
}

/** The threshold that applies, given what the tap last told us about itself. */
export function lapseThresholdMs(hidden: boolean): number {
  return hidden ? LAPSE_HIDDEN_MS : LAPSE_VISIBLE_MS;
}

/**
 * Has the heartbeat lapsed?
 *
 * A session that has never heard from a tap has not "lapsed" — it was never
 * armed. Arming is what a first frame does (FR-007g), so `null` here means
 * there is nothing to be stale about yet.
 */
export function heartbeatLapsed(i: LivenessInput): boolean {
  if (i.lastHeartbeatAt === null) return false;
  return i.now - i.lastHeartbeatAt > lapseThresholdMs(i.hidden);
}

export type WithholdReason = "not_receiving" | "incompatible" | "version_rejected";

export interface WithholdInput extends LivenessInput {
  tapState: TapReportedState | null;
}

/**
 * Should recommendations be withheld? (FR-007f)
 *
 * Withhold when the board is KNOWN-STALE, and only then:
 *
 *  * lapsed heartbeat — we are not receiving picks at all;
 *  * `incompatible`   — the tap's protocol no longer matches, so picks are
 *                       provably being missed;
 *  * `version-rejected` — the tap speaks a contract this server refuses.
 *
 * Deliberately NOT withheld:
 *
 *  * `buffering` — the tap is working CORRECTLY through an outage. Its picks
 *    are retained and will arrive. Withholding here would make the feature look
 *    broken during an ordinary blip, which is the failure mode that teaches an
 *    owner to ignore the indicator entirely.
 *  * `draft-end-unknown` — the room went quiet and the tap cannot confirm the
 *    draft ended. The picks in hand are most likely the complete set.
 *
 * A rule that only ever withholds is as wrong as one that never does; SC-001c
 * asserts both directions for exactly that reason.
 */
export function withholdReason(i: WithholdInput): WithholdReason | null {
  if (i.tapState === "incompatible") return "incompatible";
  if (i.tapState === "version-rejected") return "version_rejected";
  if (heartbeatLapsed(i)) return "not_receiving";
  return null;
}

/** Convenience for the API surface and the diagnostic page. */
export function isWithholding(i: WithholdInput): boolean {
  return withholdReason(i) !== null;
}

/**
 * 011 T043 — is this draft LIVE, for the purpose of refusing to wipe it?
 *
 * ONE implementation, two callers (FR-031d2):
 *   * the owner asking to reset a session      (FR-030)
 *   * a sync observing an ESPN reset            (FR-031d)
 *
 * They differ only in trigger. Two copies of a live-draft guard will diverge,
 * and the one that diverges is the one that fires at the wrong moment.
 *
 * IT IS DELIBERATELY NOT ABOUT PICK RECENCY, and that is the whole point. 005
 * measured inter-pick gaps from ~1 s under autodraft to **90 s+ between human
 * picks**, and concluded that liveness comes from the heartbeat rather than
 * from pick silence. A "picks in the last N seconds" test would wipe a live
 * draft while a manager deliberates over a pick — turning a guard into the
 * thing it was meant to prevent.
 *
 * So: armed, not finished, and the tap still breathing. `heartbeatLapsed`
 * already applies the right threshold for a hidden tab (150 s) versus a visible
 * one (45 s), because a backgrounded tab throttles its timers to about one a
 * minute and the ratified design expects that tab to be backgrounded.
 */
export interface LiveDraftInput extends LivenessInput {
  /** The session's recorded status. */
  status: string;
  /** Set once the draft has completed. Non-null ⇒ nothing live to protect. */
  completedAt: string | null;
}

export function isLiveDraft(i: LiveDraftInput): boolean {
  // A finished draft is not live. This is what makes reset possible at all —
  // the ordinary case is resetting something that has completed.
  if (i.completedAt !== null) return false;
  // Never armed, aborted, or unsupported: nothing in flight to protect.
  if (!["armed", "live", "not_receiving", "degraded"].includes(i.status)) return false;
  // A session that has never heard from a tap is not live — `heartbeatLapsed`
  // returns false for a null heartbeat because there is nothing to be stale
  // about, so that case is excluded explicitly rather than by accident.
  if (i.lastHeartbeatAt === null) return false;
  return !heartbeatLapsed(i);
}
