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

function render(state: TapState, detail = ""): void {
  const changed = state !== status.state;
  status.state = state;
  status.detail = detail;
  if (changed) reportStatus(state, detail);
  if (!badge) return;
  // Never render a URL: the draft-room URL carries the owner's SWID as a query
  // parameter, so any detail string is scrubbed before it is displayed.
  const safe = detail.replace(/https?:\/\/\S+/g, "<url>").replace(/\{[0-9A-Fa-f-]{20,}\}/g, "<id>");
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
      data: JSON.stringify({ state, detail: detail.replace(/https?:\/\/\S+/g, "<url>"), tapVersion: TAP_VERSION }),
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
  switch (c.kind) {
    case "pick": {
      const payload = filterPickFields(c.fields);
      if (payload) enqueue("pick", payload, transport);
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
          noteLedger(ledger.totalSlots, picks.length);
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

/**
 * T045 — draft-end detection. ESPN's STATE frame marks phase changes, and the
 * ledger tells us when every slot is filled. Where neither is conclusive the tap
 * says so rather than going quiet: SC-014 forbids idle and dead looking alike.
 */
let ledgerSlots = 0;
let ledgerFilled = 0;

function onDraftState(raw: string): void {
  const phase = Number(raw.replace(/\n$/, "").split(" ")[1] ?? NaN);
  // Phase values are not documented and were not settled by the US1 capture, so
  // we do not map them to meanings. A change is reported; it is not interpreted.
  if (Number.isFinite(phase)) render(status.state, `draft phase ${phase}`);
}

function noteLedger(total: number, filled: number): void {
  ledgerSlots = total;
  ledgerFilled = filled;
  if (total > 0 && filled >= total) render("draft-finished");
}

// --- start ---------------------------------------------------------------

function start(): void {
  const result = install(W, {
    isDraftChannel,
    onFrame: (raw, transport) => onFrame(raw, transport),
    onChannel: (event) => {
      if (event === "open") render(token() ? "watching" : "not-paired");
    },
    onError: (m) => render("incompatible", m),
  });

  // In an ISOLATED world `window.WebSocket` is not the page's, and the tap would
  // observe nothing while appearing perfectly healthy. Assert, loudly.
  if (!result.pageWorld) {
    render("incompatible", "could not attach to the page — picks are NOT being captured");
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
    W.alert(
      `${status.state}\n\n${EXPLANATIONS[status.state]}\n\n` +
        `buffered: ${status.buffered}\nunrecognised: ${status.unrecognisedCount}\n` +
        `picks in ledger: ${ledgerFilled}/${ledgerSlots || "?"}\nversion: ${TAP_VERSION}`,
    );
  });
  GM_registerMenuCommand("Draft Genie: paste pairing token", () => {
    const t = W.prompt("Paste the pairing token from Draft Genie settings:");
    if (t) { GM_setValue("dg:token", t.trim()); render("watching"); flush(); }
  });
}

start();
