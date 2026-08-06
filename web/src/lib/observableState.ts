// 011 T006 — what each surface may say, and the remedy that must go with it.
//
// PURE. No platform imports, no clock: this is vocabulary, not behaviour.
//
// It lives in `web/src/lib/` rather than `src/draft/` because BOTH consumers are
// pages — the draft room and the tap page — and `web/src` deliberately imports
// nothing from the Worker tree. 007 established that boundary and it is worth
// keeping: the room's judgement lives in pure browser-side modules, which is
// what let SC-005 be measured offline with no jsdom and no new dependency.
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

/**
 * 011 T017/T018 — the room's state, decided here rather than in the component.
 *
 * `DraftRoom.tsx` is a RENDERING SHELL (007). Putting this ternary in the
 * component is how it became untestable, and untestable is how it came to say
 * "cannot reach Draft Genie" seven minutes before a draft when the only thing
 * true was that no session had armed yet.
 *
 * THE DISTINCTION THAT MATTERS: `waiting_for_draft` is not a failure. It is the
 * normal state of a league whose draft has not started, and it must never be
 * reported as a reachability problem.
 */
export interface RoomInputs {
  /** Has a session ever armed for this league? False ⇒ nothing is wrong. */
  sessionArmed: boolean;
  /** The socket's own view. `reconnecting` is expected, not yet a failure. */
  reachability: "connected" | "reconnecting" | "polling";
  /** Has this session observed at least one pick? Drives `relay_stopped`. */
  hasSeenPicks: boolean;
  /** Is a relay currently delivering? */
  receiving: boolean;
}

export function roomStateOf(i: RoomInputs): StateReport<RoomState> {
  // Ordered by what the reader most needs to know, and the first branch is the
  // bug: no session means the draft has not started, whatever the socket says.
  if (!i.sessionArmed) return roomReport("waiting_for_draft");

  // A reconnect that is still expected to succeed is not a failure (FR-014).
  // Only a fallback to polling means the transport has actually given up.
  if (i.reachability === "polling") return roomReport("cannot_reach");

  if (i.receiving) return roomReport("connected");

  // Frames arrived and stopped is a DIFFERENT fact from frames never arriving,
  // and the remedy is the same but the reassurance is not: one says something
  // broke, the other says nobody has started relaying.
  return roomReport(i.hasSeenPicks ? "relay_stopped" : "not_receiving");
}

/**
 * 011 T020/T021/T022 — the tap page's state, decided rather than guessed.
 *
 * NO CLOCK: `nowMs` is a parameter. This module is pure, which is what lets the
 * whole state matrix be tested without a browser (SC-005).
 */
export interface TapInputs {
  /**
   * Has the userscript announced itself on this page?
   *
   * **`null` means we could not tell**, and it is a real answer. Until the
   * script matches Draft Genie's own origin (T027) the server cannot
   * distinguish "not installed" from "installed but never enabled" — and
   * guessing between them is what sends someone to re-do setup that was fine.
   */
  scriptDetected: boolean | null;
  /** Live enablements for this account, newest first. */
  enablements: { lastUsedAt: string | null; revoked: boolean }[];
  nowMs: number;
}

/**
 * How recently a relay must have been seen to count as active.
 *
 * 150 s, matching 005's hidden-tab heartbeat lapse. A backgrounded tab's timers
 * throttle to roughly one a minute, and 005 already learned that a single
 * tighter threshold declares a healthy backgrounded tap dead — which is the
 * error this whole story exists to stop making.
 */
export const RELAY_FRESH_MS = 150_000;

export function tapStateOf(i: TapInputs): StateReport<TapState> {
  const live = i.enablements.filter((e) => !e.revoked);

  if (live.length === 0) {
    // No enablement. Whether the script is present decides which of the two
    // "not set up" states this is — and if we cannot tell, we say so.
    if (i.scriptDetected === false) return tapReport("not_installed");
    if (i.scriptDetected === true) return tapReport("installed_not_enabled");
    return tapReport("unknown");
  }

  const lastUsed = live
    .map((e) => (e.lastUsedAt ? Date.parse(e.lastUsedAt) : null))
    .filter((t): t is number => t !== null && Number.isFinite(t))
    .sort((a, b) => b - a)[0];

  // Enabled but never used: the credential exists and no draft room has been
  // opened with it. Distinct from "stopped", which is why `lastUsed` is checked
  // for existence before recency (FR-010).
  if (lastUsed === undefined) return tapReport("enabled_idle");

  return i.nowMs - lastUsed <= RELAY_FRESH_MS
    ? tapReport("relaying", { lastRelayedAt: new Date(lastUsed).toISOString() })
    : tapReport("enabled_idle");
}
