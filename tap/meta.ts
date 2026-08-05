// 010 T010 — the single source of the tap's identity and version.
//
// FR-022 requires the tap to report its own version, and the build asserts that
// the metadata banner below and TAP_VERSION agree. esbuild does not touch the
// banner, so without that assertion the two can silently diverge and the tap
// would report a version it is not.

/** Bumped on every shipped change. The build fails if the banner disagrees. */
export const TAP_VERSION = "0.1.6";

/** Wire-contract version, sent on every message. 005 rejects what it cannot read. */
export const CONTRACT_VERSION = 1;

/** Where the tap relays to. `@connect` is scoped to exactly this host. */
export const INGEST_ORIGIN = "https://draft.neelamjai.com";

/**
 * The draft-room host, established by the US1 capture:
 *   wss://fantasydraft.espn.com/game-1/league-<id>/JOIN?…
 *
 * URL scoping is MANDATORY, not defensive: ESPN's commons bundle opens a second
 * unrelated WebSocket to espn.connections.edge.bamgrid.com on the same page
 * (four of them in the capture). Wrapping the global unscoped would relay that
 * traffic and feed its JSON to the draft classifier, firing FR-017a's
 * unrecognised counter continuously — the exact false alarm it exists to
 * prevent.
 */
export const DRAFT_HOST = "fantasydraft.espn.com";

/** Also seen in the capture; scoping must exclude it explicitly. */
export const IGNORED_HOSTS = ["espn.connections.edge.bamgrid.com"];

/**
 * Userscript metadata block. `@run-at document-start` is load-bearing — the
 * wrapper must be installed before ESPN's client constructs its transport — and
 * `@require` is deliberately absent because it is documented to delay injection
 * past document-start.
 *
 * The US1 capture confirmed `navigationType: "navigate"` and
 * `isTopFrame: true`, so a document-load hook fires and `@noframes` is safe.
 */
export const META_BLOCK = `// ==UserScript==
// @name         Draft Genie draft tap
// @namespace    ${INGEST_ORIGIN}/
// @version      ${TAP_VERSION}
// @description  Passively relays your own ESPN draft-room picks to Draft Genie. Opens nothing to ESPN and sends nothing to ESPN.
// @author       Draft Genie
// @match        https://fantasy.espn.com/football/draft*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @noframes
// @connect      draft.neelamjai.com
// @updateURL    ${INGEST_ORIGIN}/draft-tap.user.js
// @downloadURL  ${INGEST_ORIGIN}/draft-tap.user.js
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==`;
