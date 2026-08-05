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
import { classify, isDraftChannel } from "./classify";
import { decodeInitFrame, filledPicks } from "./decode";
import { assertTransmittable, filterLedgerPick, filterPickFields } from "./filter";
import { FLUSH_TIMEOUT_MS, Sequencer, backoffMs, chunk, type Clock, type RelayMessage } from "./batch";
import { Buffer as TapBuffer, type StoragePort } from "./buffer";
import { EXPLANATIONS, isDegraded, type TapState, type TapStatus } from "./status";
import { install, type Transport } from "./intercept";
import { DraftEnd } from "./draftEnd";

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

const PAGE_PROMPT = captureNative(W.prompt);
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
  try {
    GM_xmlhttpRequest({
      method: "POST",
      url: `${INGEST_ORIGIN}/api/tap/status`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, "X-Tap-Install": installId() },
      anonymous: true,
      data: JSON.stringify({ state, detail: scrubDetail(detail), tapVersion: TAP_VERSION }),
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

// FR-004: relay draft-state messages in order, identifying the league.
// FR-005a: the stable identity is the player id (SELECTED carries no ordinal).
function onFrame(raw: string, transport: Transport): void {
  const c = classify(raw);
  // FR-024: a completed draft emits nothing we should forward. Status frames
  // still go out — stopping the relay must not also stop saying why.
  if (!draftEnd.shouldRelay(c.kind === "unrecognised" ? "status" : c.kind)) return;
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

function start(): void {
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

  // In an ISOLATED world `window.WebSocket` is not the page's, and the tap would
  // observe nothing while appearing perfectly healthy. Assert, loudly.
  if (!result.pageWorld) {
    render("incompatible", `could not attach to the page — picks are NOT being captured (${result.reason})`);
    return;
  }

  const params = new URLSearchParams(W.location.search);
  league.espnLeagueId = params.get("leagueId") ?? "";
  league.season = Number(params.get("seasonId") ?? new Date().getFullYear());

  W.addEventListener("DOMContentLoaded", mountBadge);
  if (W.document.readyState !== "loading") mountBadge();

  // Event-driven flush. A chained setTimeout in a hidden tab is throttled to one
  // per second and then ONE PER MINUTE, which alone would fail the 60s recovery
  // target — hence these triggers, with the timer only as a backstop.
  for (const ev of ["online", "pageshow", "focus"] as const) {
    W.addEventListener(ev, () => { sequencer.reanchor(); flush(); });
  }
  W.document.addEventListener("visibilitychange", () => {
    if (!W.document.hidden) { sequencer.reanchor(); flush(); }
  });

  render(token() ? "watching" : "not-paired");

  GM_registerMenuCommand("Draft Genie: status", () => {
    const text =
      `${status.state}\n\n${EXPLANATIONS[status.state]}\n\n` +
      `buffered: ${status.buffered}\nunrecognised: ${status.unrecognisedCount}\n` +
      `picks seen: ${draftEnd.seenCount}/${draftEnd.totalSlots || "?"}\nversion: ${TAP_VERSION}`;
    // Carries no secret, but the same reasoning applies: use the reference we
    // took at document-start, not whatever the page has since installed.
    if (PAGE_ALERT) PAGE_ALERT.call(W, text);
    else render(status.state, "cannot display status — the page replaced alert()");
  });
  GM_registerMenuCommand("Draft Genie: paste pairing token", () => {
    if (!PAGE_PROMPT) {
      // Refuse. Handing the token to whatever replaced prompt() is exactly the
      // failure this guard exists to prevent, and a token is not revocable by
      // the person who typed it.
      render(
        status.state,
        "cannot accept a token on this page — prompt() was replaced. Pair from Draft Genie instead.",
      );
      return;
    }
    const t = PAGE_PROMPT.call(W, "Paste the pairing token from Draft Genie settings:");
    if (t) { GM_setValue("dg:token", String(t).trim()); render("watching"); flush(); }
  });
}

start();
