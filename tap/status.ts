// 010 T025 — the status model.
//
// Two states exist purely to prevent silent failure, which is the one behaviour
// this feature must never have (FR-017):
//
//  * INCOMPATIBLE — the message shape stopped matching, OR the page-world
//    preflight failed. The latter matters because in an isolated world
//    `window.WebSocket` is not the page's and the tap observes nothing while
//    looking perfectly healthy.
//  * DRAFT_FINISHED vs WATCHING — SC-014 forbids idle and dead looking the same.

export type TapState =
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

export interface TapStatus {
  state: TapState;
  tapVersion: string;
  lastRelayedAt: string | null;
  buffered: number;
  unrecognisedCount: number;
  detail: string;
}

/** Plain-language, actionable — FR-016. Never a bare code. */
//
// THE STATE NAMES ARE STALE; THE COPY IS NOT. 011 US3 replaced the pairing
// ritual with a single acknowledgement, and T057/T058 took the old vocabulary
// out of the web UI — `DraftTap.tsx` says so in as many words. This file was
// missed, so the badge went on naming a step the product no longer has: there
// is no such control anywhere, only Enable. It was the FIRST thing a freshly
// installed tap said (`main.ts` renders `not-paired` on startup when no
// credential is held), so the one instruction that had to be right was the one
// still describing the removed flow.
//
// The phrases themselves are not repeated here on purpose — `tests/tap/
// vocabulary.test.ts` scans the shipped bundle for them, and a comment quoting
// one would fail the guard that protects this very line.
//
// The KEYS keep the old names on purpose. They are a wire contract — the tap
// posts them to `/api/tap/status`, the server stores them in
// `draft_sessions.tap_state`, and `liveness.ts` reads them back. Renaming them
// would strand the 0.1.8 taps already installed until every browser updated,
// which is a migration, not a copy fix. Only the human-readable half moves.
export const EXPLANATIONS: Record<TapState, string> = {
  "not-paired": "Not enabled in this browser yet. Open Draft Genie, then click Enable.",
  paired: "Enabled, waiting for a draft room.",
  "not-a-draft-page": "This is not an ESPN draft room, so nothing is being watched.",
  watching: "Draft room open, waiting for picks.",
  relaying: "Sending picks to Draft Genie.",
  buffering: "Cannot reach Draft Genie — picks are being saved and will be sent when it returns.",
  "version-rejected": "Draft Genie does not understand this version of the tap. Update it.",
  incompatible:
    "ESPN's draft messages no longer match what this tap understands, or it could not attach to the page. " +
    "Picks are NOT being captured — update the tap.",
  "draft-finished": "Draft complete. Nothing further to send.",
  "draft-end-unknown":
    "The draft room has gone quiet and this tap cannot confirm the draft finished — it never saw a complete " +
    "pick list. If the draft is over, nothing is wrong. If it is not, reload the draft room.",
};

export function describe(status: TapStatus): string {
  return `${status.state}: ${EXPLANATIONS[status.state]}`;
}

/** A tap that has seen unrecognised messages is not healthy, even if it is
 *  relaying — ESPN silently drops unknown verbs and we deliberately do not. */
export function isDegraded(status: TapStatus): boolean {
  return (
    status.unrecognisedCount > 0 ||
    status.state === "incompatible" ||
    status.state === "version-rejected" ||
    status.state === "buffering"
  );
}
