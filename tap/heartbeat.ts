// 010 T055 — periodic liveness (005 FR-007e).
//
// WHY THIS EXISTS: the tap reports only on state *change*, so a healthy tap is
// SILENT. That is precisely the case 005 needs to observe — it must tell "the
// draft is slow" from "the tap is dead", and pick silence cannot: measured gaps
// run from ~1 s between autodrafted picks to 90 s+ between human ones. So the
// tap says "still here" on a timer, independently of pick traffic.
//
// WHY IT REPORTS ITS OWN VISIBILITY: a hidden tab's timers are throttled to
// 1/second, and to **1/minute** after 5 chained timers with the tab hidden 5
// minutes (research §"Gotchas"). The draft-room tab is very often hidden — the
// ratified design has the tap on the machine with the draft room open and the
// recommendation UI somewhere else entirely — so a 15 s heartbeat degrades to
// 60 s exactly when nobody is looking at it. A receiver applying one threshold
// would then report "not receiving picks" for a perfectly healthy tap, during
// the one hour that mistake is most expensive.
//
// The tap cannot fix the throttling, but it knows whether it is subject to it.
// So it states that, and the receiver picks the matching threshold. Reporting a
// fact the other side cannot otherwise observe is cheaper than either side
// guessing.

/** Nominal interval. The browser may stretch this; `hidden` says when. */
export const HEARTBEAT_MS = 15_000;

/** Floor between sends, so an event storm cannot become a request storm. */
export const HEARTBEAT_MIN_GAP_MS = 5_000;

export interface HeartbeatDecision {
  send: boolean;
  /** Why, for the badge and for tests. Never sent to the server. */
  reason: "due" | "event" | "first" | "too-soon" | "not-paired";
}

export interface HeartbeatInput {
  now: number;
  lastSentAt: number | null;
  paired: boolean;
  /** True when driven by visibilitychange/pageshow/focus/online rather than the timer. */
  triggeredByEvent: boolean;
}

/**
 * Should a heartbeat go out now?
 *
 * Event-driven *and* timed, for the same reason the flush is: the timer alone
 * is throttled in a hidden tab, and the events are what make a wake-up
 * immediately visible to the receiver rather than up to a minute later.
 */
export function shouldSendHeartbeat(i: HeartbeatInput): HeartbeatDecision {
  if (!i.paired) return { send: false, reason: "not-paired" };
  if (i.lastSentAt === null) return { send: true, reason: "first" };
  const since = i.now - i.lastSentAt;
  if (since < HEARTBEAT_MIN_GAP_MS) return { send: false, reason: "too-soon" };
  if (i.triggeredByEvent) return { send: true, reason: "event" };
  return since >= HEARTBEAT_MS ? { send: true, reason: "due" } : { send: false, reason: "too-soon" };
}
