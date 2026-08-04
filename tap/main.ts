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
import { Sequencer, backoffMs, chunk, type Clock, type RelayMessage } from "./batch";
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
function render(state: TapState, detail = ""): void {
  status.state = state;
  status.detail = detail;
  if (!badge) return;
  badge.textContent = `Draft Genie: ${state}${detail ? ` — ${detail}` : ""}`;
  badge.style.background = isDegraded(status) ? "#7a2020" : "#20502a";
  badge.title = EXPLANATIONS[state];
}

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

const league = { espnLeagueId: "", season: 0, connectionId: "" };
const sequencer = new Sequencer(clock, installId(), SESSION, league);
const buffer = new TapBuffer(gmStorage, installId(), SESSION);
let failures = 0;
let flushing = false;

function token(): string {
  return GM_getValue("dg:token", "");
}

function flush(): void {
  if (flushing || !token()) return;
  const pending = buffer.pending();
  if (!pending.length) return;
  flushing = true;
  const batch = chunk(pending)[0]!;
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
      connectionId: league.connectionId,
      messages: batch,
    }),
    onload: (r) => {
      flushing = false;
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
      render("buffering", `server said ${r.status}`);
      scheduleRetry(r.responseHeaders);
    },
    onerror: () => {
      flushing = false;
      failures++;
      status.buffered = buffer.size();
      render("buffering", "cannot reach Draft Genie");
      scheduleRetry();
    },
  });
}

function scheduleRetry(responseHeaders?: string): void {
  const retryAfter = /retry-after:\s*(\d+)/i.exec(responseHeaders ?? "")?.[1];
  // A timer alone is throttled to one per minute in a hidden tab, which would
  // break the 60s recovery target — this is only a backstop. The real triggers
  // are the events wired in start().
  setTimeout(flush, backoffMs(failures, retryAfter ? Number(retryAfter) : undefined));
}

function enqueue(kind: "pick" | "ledger" | "status", payload: unknown, transport: Transport): void {
  assertTransmittable(payload); // fail closed rather than leak
  const msg: RelayMessage = sequencer.build(kind, payload, transport);
  buffer.append(msg);
  status.buffered = buffer.size();
  flush();
}

// --- frame handling ------------------------------------------------------

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
        if (ledger) enqueue("ledger", filledPicks(ledger).map(filterLedgerPick), transport);
      } catch (e) {
        status.unrecognisedCount++;
        render("incompatible", `ledger: ${(e as Error).message}`);
      }
      return;
    }
    case "known-non-draft":
      return; // silently dropped, by design
    case "unrecognised":
      // ESPN's own parser silently drops unknown verbs. We deliberately do not.
      status.unrecognisedCount++;
      render("incompatible", `unknown message "${c.verb}"`);
      enqueue("status", { state: "incompatible", verb: c.verb }, transport);
      return;
  }
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
  league.connectionId = GM_getValue(`dg:conn:${league.espnLeagueId}`, "");

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
    W.alert(`${status.state}\n\n${EXPLANATIONS[status.state]}\n\nbuffered: ${status.buffered}\nversion: ${TAP_VERSION}`);
  });
  GM_registerMenuCommand("Draft Genie: paste pairing token", () => {
    const t = W.prompt("Paste the pairing token from Draft Genie settings:");
    if (t) { GM_setValue("dg:token", t.trim()); render("watching"); flush(); }
  });
}

start();
