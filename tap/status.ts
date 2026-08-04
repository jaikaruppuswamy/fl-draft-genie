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
  | "draft-finished";

export interface TapStatus {
  state: TapState;
  tapVersion: string;
  lastRelayedAt: string | null;
  buffered: number;
  unrecognisedCount: number;
  detail: string;
}

/** Plain-language, actionable — FR-016. Never a bare code. */
export const EXPLANATIONS: Record<TapState, string> = {
  "not-paired": "Not linked to Draft Genie yet. Open Draft Genie settings and pair this browser.",
  paired: "Linked, waiting for a draft room.",
  "not-a-draft-page": "This is not an ESPN draft room, so nothing is being watched.",
  watching: "Draft room open, waiting for picks.",
  relaying: "Sending picks to Draft Genie.",
  buffering: "Cannot reach Draft Genie — picks are being saved and will be sent when it returns.",
  "version-rejected": "Draft Genie does not understand this version of the tap. Update it.",
  incompatible:
    "ESPN's draft messages no longer match what this tap understands, or it could not attach to the page. " +
    "Picks are NOT being captured — update the tap.",
  "draft-finished": "Draft complete. Nothing further to send.",
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
