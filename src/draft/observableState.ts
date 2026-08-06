// 011 T006 — what each surface may say, and the remedy that must go with it.
//
// PURE. No platform imports, no clock: this is vocabulary, not behaviour.
//
// It lives in one file because the two surfaces describe the same system and
// drifted apart once already. On 2026-08-05, seven minutes before a draft, the
// draft room said Draft Genie could not be reached while nothing was wrong —
// the session simply had not armed yet — and at the same time the tap page could
// not distinguish "working" from "broken", so a WORKING credential was revoked
// and replaced twice under time pressure. Three pairings in fourteen minutes.
//
// The lesson is narrower than "improve the messages": a state that does not name
// its remedy gets fixed by guesswork, and guesswork under time pressure breaks
// things that were fine. So a remedy is part of the type, not an afterthought
// somewhere in a component.

/** What the tap page can truthfully say about this browser (FR-008). */
export type TapState =
  | "not_installed"
  | "installed_not_enabled"
  | "enabled_idle"
  /** Only claimable with evidence — see `RelayEvidence` (FR-009). */
  | "relaying"
  | "unknown";

/** What the draft room can truthfully say about this league (FR-011, FR-012). */
export type RoomState =
  /** No session armed. NOT a failure — the draft has not started. */
  | "waiting_for_draft"
  /** A session exists; the browser cannot reach the service. */
  | "cannot_reach"
  /** Reachable, but no frames are arriving. */
  | "not_receiving"
  /** Frames were arriving and stopped (FR-006a). */
  | "relay_stopped"
  | "connected"
  | "unknown";

/**
 * Evidence that a relay is alive.
 *
 * `lastRelayedAt` is REQUIRED to claim `relaying`. "It is working" without a
 * timestamp is an assertion, and an unevidenced assertion is exactly what let a
 * healthy tap look broken.
 */
export interface RelayEvidence {
  lastRelayedAt: string;
}

export interface StateReport<S extends string> {
  state: S;
  /** What the reader should DO. Never optional (FR-013). */
  remedy: string;
  /** Present only where the state is evidenced rather than inferred. */
  evidence?: RelayEvidence;
}

/**
 * Remedies for the tap page.
 *
 * Written here rather than in the component so the two surfaces cannot say
 * different things about the same condition.
 */
export const TAP_REMEDY: Record<TapState, string> = {
  not_installed: "Install the Draft Genie userscript in desktop Chrome.",
  installed_not_enabled: "Open this page while signed in and confirm once to enable the tap.",
  enabled_idle: "Open your ESPN draft room. This tab is the tap — leave it open.",
  relaying: "Nothing to do. Leave the ESPN draft-room tab open.",
  // Never a guess. Saying "unknown" is what stops someone re-doing setup that
  // was already working.
  unknown: "Can't tell right now. Reload this page before changing anything.",
};

/**
 * Remedies for the draft room.
 *
 * `relay_stopped` deliberately gives ONE message to everyone (FR-006a). A
 * manager who cannot relay — on an iPad, or the ESPN app — can still act on it
 * by asking a leaguemate who can, and one message is one thing to keep true.
 */
export const ROOM_REMEDY: Record<RoomState, string> = {
  waiting_for_draft: "Nothing is wrong — the draft hasn't started yet.",
  cannot_reach: "Can't reach Draft Genie. Check your connection; this will retry on its own.",
  not_receiving:
    "Connected, but no picks are arriving. Someone in this league needs an ESPN draft room open in desktop Chrome.",
  relay_stopped:
    "Picks have stopped arriving. Someone in this league needs an ESPN draft room open in desktop Chrome.",
  connected: "Nothing to do.",
  unknown: "Can't tell right now.",
};

/** Every tap state, for the completeness assertion SC-005 requires. */
export const TAP_STATES: readonly TapState[] = [
  "not_installed",
  "installed_not_enabled",
  "enabled_idle",
  "relaying",
  "unknown",
];

/** Every room state, same purpose. */
export const ROOM_STATES: readonly RoomState[] = [
  "waiting_for_draft",
  "cannot_reach",
  "not_receiving",
  "relay_stopped",
  "connected",
  "unknown",
];

/**
 * Build a tap report, refusing to claim `relaying` without evidence.
 *
 * The refusal is the point: a caller that has no `lastRelayedAt` cannot assert
 * health by accident, because the only way to say `relaying` is to supply the
 * proof.
 */
export function tapReport(state: TapState, evidence?: RelayEvidence): StateReport<TapState> {
  if (state === "relaying" && !evidence) {
    return { state: "unknown", remedy: TAP_REMEDY.unknown };
  }
  return { state, remedy: TAP_REMEDY[state], ...(evidence ? { evidence } : {}) };
}

export function roomReport(state: RoomState): StateReport<RoomState> {
  return { state, remedy: ROOM_REMEDY[state] };
}
