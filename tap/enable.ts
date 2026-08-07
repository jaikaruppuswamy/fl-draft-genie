// 011 US3 — deciding whether a click is a real person enabling the relay.
//
// A pure module, for the reason the tap's header states: everything with logic
// lives where it can be tested. The first draft of draft-end detection was four
// lines inside `main.ts` where nothing could reach it, and it shipped broken.
// This decides whether to hand out a credential, so it gets the same treatment
// and then some.
//
// FR-018: enabling MUST require a genuine user action and MUST NOT be
// triggerable by a page the owner merely visits. Everything here is that one
// sentence, made checkable.
//
// WHAT THIS CANNOT DEFEND AGAINST, stated plainly rather than implied:
// `@inject-into page` and `@sandbox raw` put this script in the SAME JavaScript
// realm as the page. A hostile script that runs at document-start on our own
// origin, before this one, can replace anything it inspects. There is no
// defence against that in this architecture — only the observation that it is a
// far higher bar than the flow being replaced, where a single same-origin
// `fetch` returned a 180-day bearer with no race at all.

/** Everything the decision depends on, as plain data. */
export interface GestureInput {
  /** The browser's own word that a human generated this event. */
  isTrusted: boolean;
  /** 0 is the primary button. A synthetic middle-click is not an intent. */
  button: number;
  /** `navigator.userActivation.isActive` — the page is inside a real gesture. */
  activationActive: boolean;
  /** The enable control was genuinely on the event's composed path. */
  pathHasTarget: boolean;
  /** That element is still in the document (not a detached decoy). */
  inDocument: boolean;
  /** It occupies space — a 0×0 or hidden element is not something anyone clicked. */
  hasBox: boolean;
  /** We are the top document. A framed click is somebody else's click. */
  topFrame: boolean;
  /** `location.origin` is exactly Draft Genie's. */
  originMatches: boolean;
  /** Every native function this flow relies on was captured intact. */
  nativesIntact: boolean;
}

export type RefusalReason =
  | "not_our_origin"
  | "framed"
  | "natives_replaced"
  | "not_trusted"
  | "not_primary_button"
  | "no_user_activation"
  | "not_the_enable_control"
  | "target_not_in_document"
  | "target_not_visible";

export type GestureVerdict = { mint: true } | { mint: false; reason: RefusalReason };

/**
 * Ordered most-fundamental first, so a refusal names the outermost thing that
 * was wrong. "You are framed" is more useful than "that button has no box"
 * when both are true, and the outer conditions are the ones an attacker
 * controls.
 *
 * Every condition is required. There is no scoring and no "two out of three" —
 * the output is a bearer credential.
 */
export function evaluateGesture(i: GestureInput): GestureVerdict {
  if (!i.originMatches) return { mint: false, reason: "not_our_origin" };
  if (!i.topFrame) return { mint: false, reason: "framed" };
  if (!i.nativesIntact) return { mint: false, reason: "natives_replaced" };
  // `isTrusted` is a filter, not the control. It is unforgeable on real events,
  // but a page in our own realm can simply wait for a genuine click — which is
  // why the checks below (is it OUR control, is it really there) matter as much.
  if (!i.isTrusted) return { mint: false, reason: "not_trusted" };
  if (i.button !== 0) return { mint: false, reason: "not_primary_button" };
  if (!i.activationActive) return { mint: false, reason: "no_user_activation" };
  if (!i.pathHasTarget) return { mint: false, reason: "not_the_enable_control" };
  if (!i.inDocument) return { mint: false, reason: "target_not_in_document" };
  if (!i.hasBox) return { mint: false, reason: "target_not_visible" };
  return { mint: true };
}

/**
 * What the owner is told when enabling does not happen (FR-021).
 *
 * Every reason names a next step, because a refusal with no next step is the
 * thing FR-016 exists to prevent. None of them names a credential.
 */
export const REFUSAL_COPY: Record<RefusalReason, string> = {
  not_our_origin: "The draft tap only enables from Draft Genie's own site.",
  framed: "This page is inside a frame. Open Draft Genie directly and try again.",
  natives_replaced:
    "Something else on this page has modified the browser's own functions, so this can't be done safely. Try again in a new tab, or with other extensions disabled.",
  not_trusted: "That click didn't come from you. Click the button itself.",
  not_primary_button: "Use a normal left click.",
  no_user_activation: "Click the button directly rather than triggering it another way.",
  not_the_enable_control: "That wasn't the enable button.",
  target_not_in_document: "The page changed while enabling. Reload and try again.",
  target_not_visible: "The enable button isn't visible. Reload and try again.",
};

/** Reasons the SERVER can give back, and what the owner should do about them. */
export type RedeemFailure =
  | "no_claim"
  | "claim_expired"
  | "claim_used"
  | "bad_preimage"
  | "unsupported_version"
  | "network";

export const REDEEM_COPY: Record<RedeemFailure, string> = {
  no_claim: "Draft Genie didn't recognise that request. Reload the page and try again.",
  claim_expired: "That took too long. Click enable again.",
  claim_used: "That request was already used. Reload the page and try again.",
  bad_preimage: "The handshake didn't match. Reload the page and try again.",
  unsupported_version: "This version of the draft tap is too old. Update it, then try again.",
  network: "Couldn't reach Draft Genie. Check your connection and try again.",
};

/**
 * A 401 arrived. Should this browser forget the credential it holds?
 *
 * It used to keep it. The badge said "not paired", `token()` still returned the
 * string, `flush()` passed its guard, and every remaining pick of the draft was
 * POSTed to a dead credential — for the rest of the session, after the owner
 * had explicitly revoked it.
 *
 * ONE EXCEPTION, and it is the one that matters: `pairing_missing_install`
 * means WE failed to send the `X-Tap-Install` header. That is a bug on this
 * side, not a dead credential, and forgetting on it would destroy a perfectly
 * good enablement over our own mistake — mid-draft, with no way back except
 * enabling again.
 *
 * Everything else — revoked, expired, unknown, wrong_install — means the token
 * cannot work in this browser again, so holding it only produces 401s.
 *
 * An UNREADABLE body forgets. A 401 from our own ingest is always an auth
 * failure, and since re-enabling is now a single click the cost of forgetting
 * one working credential is far below the cost of relaying into a 401 for a
 * whole draft. That trade only became the right way round when the paste flow
 * went away.
 */
export function shouldForgetCredential(errorCode: string): boolean {
  return errorCode !== "pairing_missing_install";
}

/**
 * Pull the error code out of a response body WITHOUT `JSON.parse`.
 *
 * This runs on ESPN's page, where `JSON` is theirs to replace. The tap's
 * standing posture is to depend on nothing the page can swap out — the same
 * reasoning that made it capture `prompt` and `alert` at document-start.
 */
export function errorCodeOf(body: string): string {
  return /"error"\s*:\s*"([a-z_]+)"/.exec(body ?? "")?.[1] ?? "";
}
