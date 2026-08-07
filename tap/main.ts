// 010 T033/T034 — the impure shell.
//
// Deliberately small: everything with logic lives in the pure modules, which are
// tested in node with no browser. What is left here is wiring, and it is short
// enough to review by eye — which matters, because this is the code that runs
// inside the user's live draft.
//
// PASSIVITY (Constitution VI / FR-001): this file contains no request to ESPN.
// The only outbound call is GM_xmlhttpRequest to Draft Genie's ingest, and the
// build asserts no ESPN request literal survives bundling.

import { CONTRACT_VERSION, INGEST_ORIGIN, TAP_VERSION } from "./meta";
import { evaluateGesture } from "./enable";
import { classify, isDraftChannel } from "./classify";
import { decodeInitFrame, filledPicks } from "./decode";
import { assertTransmittable, filterLedgerPick, filterPickFields } from "./filter";
import { FLUSH_TIMEOUT_MS, Sequencer, backoffMs, chunk, type Clock, type RelayMessage } from "./batch";
import { Buffer as TapBuffer, type StoragePort } from "./buffer";
import { EXPLANATIONS, isDegraded, type TapState, type TapStatus } from "./status";
import { install, type Transport } from "./intercept";
import { DraftEnd } from "./draftEnd";
import { HEARTBEAT_MS, shouldSendHeartbeat } from "./heartbeat";

declare const unsafeWindow: Window & typeof globalThis;
declare function GM_getValue(key: string, dflt?: string): string;
declare function GM_setValue(key: string, value: string): void;
declare function GM_deleteValue(key: string): void;
declare function GM_registerMenuCommand(label: string, fn: () => void): void;
declare function GM_xmlhttpRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  anonymous?: boolean;
  onload?: (r: { status: number; responseText: string; responseHeaders: string }) => void;
  onerror?: (e: unknown) => void;
}): void;

const W: Window & typeof globalThis = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

// --- page-reachable functions --------------------------------------------
//
// T033: "No function the page can reach may close over the pairing token."
// The pairing prompt violated that literally. Under `@sandbox raw` +
// `@inject-into page` there is no second realm — `W` IS ESPN's window, so
// `W.prompt` is `window.prompt` inside ESPN's own JS, and any script on the
// page (or an XSS on it) could replace it and read the Draft Genie bearer
// token as the owner typed it in. That token authenticates writes to their
// account.
//
// `@run-at document-start` is what makes the fix possible: we execute before
// any page script, so the natives are still pristine when we take them. We
// keep those references and never re-read the globals afterwards.
//
// `Function.prototype.toString` is captured FIRST and used to verify each
// reference really is native, because a replacement could otherwise fake its
// own `toString`. If anything has already been patched by the time we run, we
// refuse to handle the token at all rather than hand it over — an unusable
// pairing command is recoverable, a stolen token is not.
const NATIVE_TO_STRING = Function.prototype.toString;

function captureNative<T>(fn: T): T | null {
  try {
    if (typeof fn !== "function") return null;
    return NATIVE_TO_STRING.call(fn).includes("[native code]") ? fn : null;
  } catch {
    return null;
  }
}

const PAGE_ALERT = captureNative(W.alert);

const gmStorage: StoragePort = {
  get: (k) => GM_getValue(k, "") || null,
  set: (k, v) => GM_setValue(k, v),
  remove: (k) => GM_deleteValue(k),
};

const clock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };

function installId(): string {
  let id = GM_getValue("dg:install", "");
  if (!id) {
    id = crypto.randomUUID();
    GM_setValue("dg:install", id);
  }
  return id;
}

/** Fresh per PAGE LOAD — never sessionStorage, which is cloned on tab
 *  duplication and would produce colliding sequence numbers. */
const SESSION = crypto.randomUUID();

const status: TapStatus = {
  state: "not-paired",
  tapVersion: TAP_VERSION,
  lastRelayedAt: null,
  buffered: 0,
  unrecognisedCount: 0,
  detail: "",
};

let badge: HTMLElement | null = null;
let lastReportedState: TapState | null = null;

/**
 * Scrub a detail string of anything identifying, for BOTH the badge and the
 * wire.
 *
 * These used to differ: the badge stripped URLs and brace-form identifiers,
 * while the status POST stripped only URLs — so the copy that left the machine
 * was the less clean of the two, and it is the one that gets logged
 * server-side. Details come from wrapper errors and ESPN message text, and the
 * draft-room URL carries the owner's SWID as a query parameter, so this is a
 * real path for an identifier to escape. One function, used by both.
 */
const GUID_ANY = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g;
function scrubDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(GUID_ANY, "<id>")
    .replace(/\{[0-9A-Fa-f-]{20,}\}/g, "<id>");
}

function render(state: TapState, detail = ""): void {
  const changed = state !== status.state;
  status.state = state;
  status.detail = detail;
  if (changed) reportStatus(state, detail);
  if (!badge) return;
  const safe = scrubDetail(detail);
  badge.textContent = `Draft Genie ${TAP_VERSION}: ${state}${safe ? ` — ${safe}` : ""}`;
  badge.style.background = isDegraded(status) ? "#7a2020" : "#20502a";
  badge.title = EXPLANATIONS[state];
}

// FR-015: show whether the tap is paired, connected and relaying, including how
// recently it last relayed something.
function mountBadge(): void {
  // Unobtrusive and never over a draft control (FR-002). Fixed to the bottom
  // corner with pointer events off so it cannot intercept a click.
  badge = W.document.createElement("div");
  Object.assign(badge.style, {
    position: "fixed", bottom: "8px", left: "8px", zIndex: "2147483647",
    font: "12px system-ui, sans-serif", color: "#fff", padding: "4px 8px",
    borderRadius: "4px", pointerEvents: "none", opacity: "0.85",
  } satisfies Partial<CSSStyleDeclaration>);
  W.document.body?.appendChild(badge);
  render(status.state);
}

// --- relay ---------------------------------------------------------------

const league = { espnLeagueId: "", season: 0 };
const sequencer = new Sequencer(clock, installId(), SESSION, league);
const buffer = new TapBuffer(gmStorage, installId(), SESSION);
let failures = 0;
let flushing = false;
let flushWatchdog: ReturnType<typeof setTimeout> | null = null;

/** `flushing` is cleared by onload/onerror. If GM_xmlhttpRequest throws
 *  synchronously, or neither callback ever fires, the flag would stay set and
 *  the tap would go permanently silent while still showing "relaying" — the
 *  exact failure FR-017 forbids. This guarantees it always clears. */
function endFlush(): void {
  flushing = false;
  if (flushWatchdog !== null) {
    clearTimeout(flushWatchdog);
    flushWatchdog = null;
  }
}

function token(): string {
  return GM_getValue("dg:token", "");
}

function flush(): void {
  if (flushing || !token()) return;
  const pending = buffer.pending();
  if (!pending.length) return;
  flushing = true;
  flushWatchdog = setTimeout(() => {
    // No response either way within the window: unwedge and report honestly.
    endFlush();
    failures++;
    render("buffering", "no response from Draft Genie");
    scheduleRetry();
  }, FLUSH_TIMEOUT_MS);
  const batch = chunk(pending)[0]!;
  try {
  GM_xmlhttpRequest({
    method: "POST",
    url: `${INGEST_ORIGIN}/api/tap/batch`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, "X-Tap-Install": installId() },
    anonymous: true, // documented: "don't send cookies with the request"
    data: JSON.stringify({
      v: CONTRACT_VERSION,
      install: installId(),
      session: SESSION,
      league: { espnLeagueId: league.espnLeagueId, season: league.season },
      // Deliberately omitted: the Worker resolves the connection from the ESPN
      // league id and season, both of which the draft-room URL gives us. The
      // tap has no way to learn Draft Genie's internal UUID.
      messages: batch,
    }),
    onload: (r) => {
      endFlush();
      if (r.status === 202) {
        failures = 0;
        try {
          const body = JSON.parse(r.responseText) as { accepted_through?: number };
          // Truncate ONLY on a read acknowledgement — never on send.
          if (typeof body.accepted_through === "number") buffer.truncate(body.accepted_through);
        } catch { /* keep the buffer; a duplicate is absorbed downstream */ }
        status.lastRelayedAt = new Date(clock.now()).toISOString();
        status.buffered = buffer.size();
        render(status.buffered ? "relaying" : "relaying");
        if (buffer.size()) flush();
        return;
      }
      failures++;
      if (r.status === 409) return render("version-rejected");
      if (r.status === 401) return render("not-paired");
      if (r.status === 403) return render("incompatible", "this ESPN league is not connected to Draft Genie");
      if (r.status === 400) return render("incompatible", "Draft Genie rejected the message shape");
      render("buffering", `server said ${r.status}`);
      scheduleRetry(r.responseHeaders);
    },
    onerror: () => {
      endFlush();
      failures++;
      status.buffered = buffer.size();
      render("buffering", "cannot reach Draft Genie");
      scheduleRetry();
    },
  });
  } catch (e) {
    endFlush();
    failures++;
    render("buffering", `relay failed: ${(e as Error).message}`);
    scheduleRetry();
  }
}

/** 005 FR-007c detects "not receiving picks" from an ABSENCE of frames; this
 *  gives it a positive signal too, so the two can be told apart. Best-effort:
 *  never buffered, never retried — a status is worthless once stale. */
function reportStatus(state: TapState, detail: string): void {
  if (!token() || state === lastReportedState) return;
  lastReportedState = state;
  postStatus(state, detail, false);
}

let lastHeartbeatAt: number | null = null;

/**
 * 005 FR-007e. A tap that only speaks when something changes is silent exactly
 * when it is healthy, and the receiver cannot tell that from a tap that died.
 *
 * `hidden` is not decoration: a background tab's timers are throttled to
 * 1/minute, so the receiver must widen its lapse threshold rather than declare
 * a healthy tap dead. See tap/heartbeat.ts for why the tap reports this itself.
 */
function heartbeat(triggeredByEvent: boolean): void {
  const decision = shouldSendHeartbeat({
    now: clock.now(),
    lastSentAt: lastHeartbeatAt,
    paired: Boolean(token()),
    triggeredByEvent,
  });
  if (!decision.send) return;
  lastHeartbeatAt = clock.now();
  postStatus(status.state, status.detail, true);
}

function postStatus(state: TapState, detail: string, isHeartbeat: boolean): void {
  if (!token()) return;
  try {
    GM_xmlhttpRequest({
      method: "POST",
      url: `${INGEST_ORIGIN}/api/tap/status`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, "X-Tap-Install": installId() },
      anonymous: true,
      data: JSON.stringify({
        state,
        detail: scrubDetail(detail),
        tapVersion: TAP_VERSION,
        heartbeat: isHeartbeat,
        // Whether OUR timers are being throttled. The receiver cannot observe
        // this and must not guess it.
        hidden: Boolean(W.document?.hidden),
        league: { espnLeagueId: league.espnLeagueId, season: league.season },
      }),
    });
  } catch { /* status reporting must never disturb the relay */ }
}

function scheduleRetry(responseHeaders?: string): void {
  const retryAfter = /retry-after:\s*(\d+)/i.exec(responseHeaders ?? "")?.[1];
  // A timer alone is throttled to one per minute in a hidden tab, which would
  // break the 60s recovery target — this is only a backstop. The real triggers
  // are the events wired in start().
  setTimeout(flush, backoffMs(failures, retryAfter ? Number(retryAfter) : undefined));
}

// FR-006b: the observation time is relayed with every message — it is not
// personal data and 005 FR-020a needs it to tell a collapsed batch from a live
// sequence. FR-010: duplicate delivery is safe; the receiver dedupes on pick
// identity, so we relay rather than suppress.
function enqueue(kind: "pick" | "ledger" | "status", payload: unknown, transport: Transport): void {
  assertTransmittable(payload); // fail closed rather than leak
  const msg: RelayMessage = sequencer.build(kind, payload, transport);
  buffer.append(msg);
  status.buffered = buffer.size();
  flush();
}

// --- frame handling ------------------------------------------------------

/** The transport that carried the most recent frame; see the announce port. */
let lastTransport: Transport = "ws";

// FR-004: relay draft-state messages in order, identifying the league.
// FR-005a: the stable identity is the player id (SELECTED carries no ordinal).
function onFrame(raw: string, transport: Transport): void {
  lastTransport = transport;
  const c = classify(raw);
  // FR-024: a completed draft emits nothing we should forward. Status frames
  // still go out — stopping the relay must not also stop saying why. Both of
  // the non-draft kinds are asked about as "status" for that reason: neither is
  // relayed as draft data, and neither should be silenced by the draft ending.
  const relayKind = c.kind === "pick" || c.kind === "ledger" ? c.kind : "status";
  if (!draftEnd.shouldRelay(relayKind)) return;
  switch (c.kind) {
    case "pick": {
      const payload = filterPickFields(c.fields);
      if (payload) {
        enqueue("pick", payload, transport);
        draftEnd.notePicks([payload.playerId]);
      }
      return;
    }
    case "ledger": {
      // Relayed on EVERY connect and before any incremental frame: the US1
      // capture proved this is what recovers picks the stream drops.
      try {
        const ledger = decodeInitFrame(raw, W.atob.bind(W));
        if (ledger) {
          const picks = filledPicks(ledger);
          enqueue("ledger", picks.map(filterLedgerPick), transport);
          draftEnd.notePicks(picks.map((p) => p.playerId), ledger.totalSlots);
        }
      } catch (e) {
        status.unrecognisedCount++;
        render("incompatible", `ledger: ${(e as Error).message}`);
      }
      return;
    }
    case "known-non-draft":
      // STATE marks draft phase transitions; everything else is genuinely inert.
      if (c.verb === "STATE") onDraftState(raw);
      return; // silently dropped, by design
    case "unrecognised":
      // ESPN's own parser silently drops unknown verbs. We deliberately do not.
      status.unrecognisedCount++;
      render("incompatible", `unknown message "${c.verb}"`);
      enqueue("status", { state: "incompatible", verb: c.verb }, transport);
      return;
  }
}

// T045 / FR-024 — draft-end detection. The rules and the reasoning live in
// tap/draftEnd.ts, where they can be tested; this is only the wiring.
const draftEnd = new DraftEnd({
  render: (state, detail) => render(state, detail),
  // 011 T038. `lastTransport` rather than a fixed value: completion is detected
  // inside frame handling, so the transport that carried the last frame is the
  // one that carried the evidence.
  announce: (completion) => enqueue("status", { state: "draft-finished", ...completion }, lastTransport),
  flush: () => flush(),
  currentState: () => status.state,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

function onDraftState(raw: string): void {
  const phase = Number(raw.replace(/\n$/, "").split(" ")[1] ?? NaN);
  // Phase values are not documented and were not settled by the US1 capture, so
  // we do not map them to meanings. A change is reported; it is not interpreted.
  if (Number.isFinite(phase)) render(status.state, `draft phase ${phase}`);
}

// --- start ---------------------------------------------------------------

// --- 011 US3: enablement, on Draft Genie's own origin ------------------------
//
// The handshake, and why it has the shape it has:
//
//   * the PAGE creates the claim under session auth, sending only a HASH. It
//     never sees a credential, so a same-origin script cannot read one out of
//     it — which is precisely what the flow this replaces did, rendering a
//     180-day bearer into the DOM.
//   * THIS SCRIPT redeems it with the preimage the page never had. Only the
//     extension can finish the exchange, and only the extension is handed the
//     token.
//
// The channel is a CustomEvent on our own document, never `postMessage`. A
// `message` listener can be driven by any page that gets a handle to our
// window; there is deliberately no such listener anywhere in this file, and a
// test asserts its absence in the shipped bundle.

/** Nonces we generated, keyed by their commit. Closure-local, never stored. */
const pendingNonces = new Map<string, { nonce: string; at: number }>();

/** A claim is worth two seconds. Longer is a credential in waiting. */
const CLAIM_TTL_MS = 120_000;

function announceResult(ok: boolean, detail: Record<string, unknown> = {}): void {
  try {
    W.document.dispatchEvent(new CustomEvent("dg:enable-result", { detail: { ok, ...detail } }));
  } catch {
    /* the page will time out and say so */
  }
}

async function hashHex(input: string): Promise<string> {
  const digest = await W.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function enablementMode(): void {
  // `@noframes` should already guarantee this. Asserted anyway — the metadata
  // block is one line away from not saying it, and a framed click is somebody
  // else's click.
  if (W.top !== W.self) return;

  // Tell the page the script is here, at document-start, before React mounts.
  // No ping, no race, and no identifier: the version and nothing else. This is
  // what turns "we cannot tell whether it is installed" into a real answer.
  try {
    W.document.documentElement.setAttribute("data-dg-tap", TAP_VERSION);
  } catch {
    /* nothing else here depends on it */
  }

  const nativesIntact =
    captureNative(W.crypto.getRandomValues) !== null &&
    captureNative(W.JSON.parse) !== null &&
    captureNative(W.EventTarget.prototype.addEventListener) !== null;

  // Capture-phase, so a page listener cannot stop propagation first.
  W.document.addEventListener(
    "click",
    (ev: Event) => {
      const mouse = ev as MouseEvent;
      const path = typeof mouse.composedPath === "function" ? mouse.composedPath() : [];
      const target = path.find(
        (n): n is Element => n instanceof Element && n.hasAttribute("data-dg-tap-enable"),
      );
      const box = target?.getBoundingClientRect();

      const verdict = evaluateGesture({
        isTrusted: mouse.isTrusted === true,
        button: typeof mouse.button === "number" ? mouse.button : -1,
        activationActive: W.navigator.userActivation?.isActive === true,
        pathHasTarget: target !== undefined,
        inDocument: target ? W.document.contains(target) : false,
        hasBox: box ? box.width > 0 && box.height > 0 : false,
        topFrame: W.top === W.self,
        originMatches: W.location.origin === INGEST_ORIGIN,
        nativesIntact,
      });
      // Silent on refusal. This handler sees EVERY click on the page, and the
      // overwhelmingly common verdict is "that was not the enable button".
      if (!verdict.mint) {
        if (target) announceResult(false, { reason: verdict.reason });
        return;
      }

      void beginClaim();
    },
    true,
  );

  // The page hands back the claim id once the server has minted it. The commit
  // rides along so a double-click cannot redeem claim 1 against nonce 2.
  W.document.addEventListener("dg:enable-claim", (ev: Event) => {
    const detail = (ev as CustomEvent).detail as { claimId?: string; commit?: string } | null;
    if (!detail?.claimId || !detail?.commit) return;
    void redeem(detail.claimId, detail.commit);
  });
}

/** Generate a nonce, tell the page its hash, and let the page mint the claim. */
async function beginClaim(): Promise<void> {
  try {
    const bytes = new Uint8Array(32);
    W.crypto.getRandomValues(bytes);
    const nonce = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const commit = await hashHex(nonce);

    // Drop anything stale before adding, so a page that clicks and never
    // returns cannot grow this without bound.
    const cutoff = clock.now() - CLAIM_TTL_MS;
    for (const [k, v] of pendingNonces) if (v.at < cutoff) pendingNonces.delete(k);
    pendingNonces.set(commit, { nonce, at: clock.now() });

    W.document.dispatchEvent(new CustomEvent("dg:tap-commit", { detail: { commit } }));
  } catch {
    announceResult(false, { reason: "natives_replaced" });
  }
}

/** Redeem the claim with the preimage. The token never touches the page. */
async function redeem(claimId: string, commit: string): Promise<void> {
  const held = pendingNonces.get(commit);
  if (!held) return announceResult(false, { reason: "no_claim" });
  pendingNonces.delete(commit);

  GM_xmlhttpRequest({
    method: "POST",
    url: `${INGEST_ORIGIN}/api/tap/enable/redeem`,
    headers: { "Content-Type": "application/json", "X-Tap-Install": installId() },
    // No cookies. The claim and the preimage are the whole authorisation, and
    // this request must not carry the owner's session anywhere.
    anonymous: true,
    data: JSON.stringify({ claim: claimId, nonce: held.nonce, v: CONTRACT_VERSION }),
    onload: (r) => {
      let body: { status?: string; token?: string; pairing_id?: string; error?: string } = {};
      try {
        body = JSON.parse(r.responseText) as typeof body;
      } catch {
        return announceResult(false, { reason: "network" });
      }
      if (r.status !== 200) return announceResult(false, { reason: body.error ?? "network" });

      // `already_enabled` returns no token and must touch nothing — FR-020, and
      // the reason re-acknowledging cannot interrupt a relay in progress.
      if (body.status === "enabled" && body.token) {
        GM_setValue("dg:token", body.token);
        render("watching");
      }
      announceResult(true, { pairingId: body.pairing_id, status: body.status });
    },
    onerror: () => announceResult(false, { reason: "network" }),
  });
}

function start(): void {
  // 011 US3 — on Draft Genie's own origin this script is not a tap.
  //
  // It handles the one-click enablement handshake and NOTHING else: no
  // interception, no badge, no menu, no buffer, no heartbeat, no relay.
  //
  // The branch is not hygiene. `install()` wraps `WebSocket` on the page, and
  // Draft Genie's own draft room opens one to itself — without this the tap
  // would proxy our app's own live feed and hand it to the draft classifier.
  // ESPN behaviour has to stay byte-for-byte what it was.
  //
  // Strict `===` against the constant, never `.includes()`: `INGEST_ORIGIN` is
  // a full origin, and a substring test would match
  // `https://draft.neelamjai.com.evil.test`.
  if (W.location.origin === INGEST_ORIGIN) {
    enablementMode();
    return;
  }

  const result = install(
    W,
    {
      isDraftChannel,
      onFrame: (raw, transport) => onFrame(raw, transport),
      onChannel: (event) => {
        if (event === "open") render(token() ? "watching" : "not-paired");
      },
      onError: (m) => render("incompatible", m),
    },
    // The probe must reach the page global INDEPENDENTLY of the scope we
    // installed on, or it can only confirm its own assumption. `unsafeWindow`
    // is that independent handle; `window` is what our own code sees, and the
    // relationship between the two is what distinguishes page-context
    // injection from a script-manager sandbox.
    {
      pageGlobal: typeof unsafeWindow !== "undefined" ? unsafeWindow : null,
      selfGlobal: typeof window !== "undefined" ? window : null,
    },
  );

  const params = new URLSearchParams(W.location.search);
  league.espnLeagueId = params.get("leagueId") ?? "";
  league.season = Number(params.get("seasonId") ?? new Date().getFullYear());

  // THE BADGE AND THE MENU COME FIRST, BEFORE ANY EARLY RETURN.
  //
  // They used to be registered after the page-world check, which meant a failed
  // preflight produced NOTHING: no badge (because `render` bails when the badge
  // is not mounted yet), no status command, and — worst — no way to paste a
  // pairing token. The tap went completely silent in exactly the situation it
  // exists to shout about, and the owner had no tool left to diagnose or fix it.
  //
  // Diagnostics must survive the failure they diagnose.
  W.addEventListener("DOMContentLoaded", mountBadge);
  if (W.document.readyState !== "loading") mountBadge();
  registerMenu();

  // In an ISOLATED world `window.WebSocket` is not the page's, and the tap would
  // observe nothing while appearing perfectly healthy. Assert, loudly — but stay
  // usable, so the owner can still pair, read the reason, and act on it.
  if (!result.pageWorld) {
    render("incompatible", `could not attach to the page — picks are NOT being captured (${result.reason})`);
    return;
  }

  // Event-driven flush. A chained setTimeout in a hidden tab is throttled to one
  // per second and then ONE PER MINUTE, which alone would fail the 60s recovery
  // target — hence these triggers, with the timer only as a backstop.
  for (const ev of ["online", "pageshow", "focus"] as const) {
    W.addEventListener(ev, () => { sequencer.reanchor(); flush(); heartbeat(true); });
  }
  W.document.addEventListener("visibilitychange", () => {
    // Heartbeat on BOTH transitions. Going hidden must be reported, or the
    // receiver keeps applying the strict threshold to a tab whose timers have
    // just been throttled, and declares a healthy tap dead.
    heartbeat(true);
    if (!W.document.hidden) { sequencer.reanchor(); flush(); }
  });

  // Backstop. Throttled to ~1/minute in a hidden tab, which is why the events
  // above exist and why `hidden` is reported.
  setInterval(() => heartbeat(false), HEARTBEAT_MS);
  heartbeat(false);

  render(token() ? "watching" : "not-paired");

}

/**
 * Registered UNCONDITIONALLY, including when the preflight has failed — see
 * `start()`. A tap that cannot observe must still be able to explain itself and
 * accept a pairing token.
 */
function registerMenu(): void {
  GM_registerMenuCommand("Draft Genie: status", () => {
    const text =
      `${status.state}\n\n${EXPLANATIONS[status.state]}\n\n` +
      // The DETAIL is what says *why* — without it "incompatible" is a label
      // with no next step, which is the thing FR-016 forbids.
      (status.detail ? `${scrubDetail(status.detail)}\n\n` : "") +
      `paired: ${token() ? "yes" : "NO — use \"paste pairing token\" below"}\n` +
      `buffered: ${status.buffered}\nunrecognised: ${status.unrecognisedCount}\n` +
      `picks seen: ${draftEnd.seenCount}/${draftEnd.totalSlots || "?"}\nversion: ${TAP_VERSION}`;
    // Carries no secret, but the same reasoning applies: use the reference we
    // took at document-start, not whatever the page has since installed.
    if (PAGE_ALERT) PAGE_ALERT.call(W, text);
    else render(status.state, "cannot display status — the page replaced alert()");
  });
  // 011 US3 removed "paste pairing token". Enabling happens with one click on
  // Draft Genie's own page and the credential never passes through a human, so
  // there is nothing left to paste — and no reason to keep a code path whose
  // whole job was accepting a secret typed into a page ESPN controls.
}

start();
