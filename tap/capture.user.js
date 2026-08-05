// ==UserScript==
// @name         Draft Genie — Gate 0 capture (THROWAWAY)
// @namespace    https://draft.neelamjai.com/
// @version      0.0.1
// @description  Discovery instrument for 010 US1. Records ESPN draft-room traffic across all four transport surfaces so field meanings can be established from data. Not the shipped tap — discard after the gate.
// @match        https://fantasy.espn.com/football/draft*
// @match        https://fantasy.espn.com/football/*draft*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      draft.neelamjai.com
// @noframes
// ==/UserScript==

// 010 T001 — the GATE instrument, not the product.
//
// Why all four surfaces: research §0 established that ESPN is WebSocket-first
// with an SSE fallback reached in ~7s of bad network, but "which surface
// actually carries draft frames" is precisely what US1 must settle from data,
// not from the bundle. XHR and fetch are included so a negative result is
// evidence rather than an assumption.
//
// PASSIVITY (Constitution VI): this script opens nothing to ESPN and sends
// nothing to ESPN. Every wrapper is construct-trap or additive-listener only.
// `send`, `onmessage`, `close` and `binaryType` are never touched.
//
// SECRETS: the draft-room URL carries the owner's SWID as a query parameter
// (research §3), so every URL is redacted before it is written to the log.
// The log is still credentialed material (FR-019a): keep it out of the repo.

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const STORE_KEY = "dg:gate0:log";
  const MAX_ENTRIES = 60000;

  const NativeWebSocket = W.WebSocket;
  const NativeEventSource = W.EventSource;
  const nativeFetch = W.fetch;
  const addEL = W.EventTarget.prototype.addEventListener;

  /** @type {Array<object>} */
  let log = [];
  let seq = 0;
  const counts = Object.create(null);

  const GUID = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g;

  /** URLs carry the SWID. Redact before anything is written. */
  function redact(value) {
    let s = String(value);
    s = s.replace(GUID, "{GUID}");
    // Query params that commonly carry identity in ESPN's draft URLs.
    s = s.replace(/([?&](?:memberId|swid|SWID|4)=)[^&]*/g, "$1REDACTED");
    return s;
  }

  function record(entry) {
    if (log.length >= MAX_ENTRIES) return;
    entry.seq = seq++;
    entry.at = new Date().toISOString();
    log.push(entry);
    counts[entry.transport] = (counts[entry.transport] || 0) + 1;
  }

  /** Frames may be string, ArrayBuffer or Blob. Preserve bytes losslessly. */
  function encodeData(data, cb) {
    try {
      if (typeof data === "string") return cb({ enc: "text", data });
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return cb({ enc: "b64", data: W.btoa(bin), len: bytes.length });
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        const fr = new FileReader();
        fr.onload = () => cb({ enc: "b64", data: String(fr.result).split(",")[1] || "", len: data.size });
        fr.onerror = () => cb({ enc: "error", data: "blob-read-failed" });
        return fr.readAsDataURL(data);
      }
      return cb({ enc: "other", data: Object.prototype.toString.call(data) });
    } catch (e) {
      return cb({ enc: "error", data: String(e && e.message) });
    }
  }

  function observe(instance, transport, url) {
    try {
      // Additive listener on the instance ESPN's own constructor returned.
      // We never replace .onmessage, so ESPN's handler is unaffected and runs
      // first (verified in research §1).
      addEL.call(instance, "message", (ev) => {
        // setTimeout, not queueMicrotask: microtasks still drain on ESPN's
        // critical path before the event loop yields.
        const data = ev && ev.data;
        setTimeout(() => {
          try {
            encodeData(data, (payload) => record({ transport, event: "message", url, ...payload }));
          } catch (e) {
            record({ transport, event: "observe-error", url, data: String(e && e.message) });
          }
        }, 0);
      });
      for (const kind of ["open", "close", "error"]) {
        addEL.call(instance, kind, () => record({ transport, event: kind, url }));
      }
    } catch (e) {
      record({ transport, event: "attach-failed", url, data: String(e && e.message) });
    }
  }

  /** Construct-trap Proxy. `newTarget` MUST be forwarded or subclassing breaks
   *  and, with it, the user's draft (research §1). */
  function wrapConstructor(Native, transport) {
    if (typeof Native !== "function") return Native;
    return new Proxy(Native, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        try {
          const url = redact(args && args[0]);
          record({ transport, event: "construct", url });
          observe(instance, transport, url);
        } catch (e) {
          // A throw here would propagate into the page's `new` and trigger
          // ESPN's own fallback path. Never let that happen.
          try {
            record({ transport, event: "wrap-error", data: String(e && e.message) });
          } catch {
            /* give up silently rather than break the page */
          }
        }
        return instance;
      },
    });
  }

  try {
    W.WebSocket = wrapConstructor(NativeWebSocket, "ws");
    W.EventSource = wrapConstructor(NativeEventSource, "sse");
  } catch (e) {
    record({ transport: "meta", event: "install-failed", data: String(e && e.message) });
  }

  // XHR: record the request URL and a bounded slice of the response. Patching
  // `open` only — `send` is never touched.
  try {
    const nativeOpen = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (method, url) {
      try {
        const clean = redact(url);
        if (/draft/i.test(clean)) {
          record({ transport: "xhr", event: "open", url: clean, data: String(method) });
          addEL.call(this, "loadend", () => {
            try {
              const body = typeof this.responseText === "string" ? this.responseText.slice(0, 4000) : "";
              record({ transport: "xhr", event: "loadend", url: clean, enc: "text", data: body });
            } catch { /* cross-origin or non-text response */ }
          });
        }
      } catch { /* never break the page */ }
      return nativeOpen.apply(this, arguments);
    };
  } catch (e) {
    record({ transport: "meta", event: "xhr-wrap-failed", data: String(e && e.message) });
  }

  // fetch: tee the body so the page's copy is untouched.
  try {
    W.fetch = function (input) {
      const url = redact(typeof input === "string" ? input : (input && input.url) || "");
      const p = nativeFetch.apply(this, arguments);
      if (!/draft/i.test(url)) return p;
      return p.then((res) => {
        try {
          if (!res.body) return res;
          const [mine, theirs] = res.body.tee();
          const reader = mine.getReader();
          const dec = new TextDecoder();
          (function pump() {
            reader.read().then(({ done, value }) => {
              if (done) return;
              record({ transport: "fetch", event: "chunk", url, enc: "text", data: dec.decode(value, { stream: true }).slice(0, 4000) });
              pump();
            }).catch(() => {});
          })();
          return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
        } catch {
          return res;
        }
      });
    };
  } catch (e) {
    record({ transport: "meta", event: "fetch-wrap-failed", data: String(e && e.message) });
  }

  // --- environment observations (T006/T007) ---
  try {
    const nav = W.performance && W.performance.getEntriesByType("navigation")[0];
    record({
      transport: "meta",
      event: "env",
      url: redact(W.location && W.location.href),
      data: JSON.stringify({
        // T006: was this a real document load? If the draft room is entered by
        // client-side navigation, document-start never fires and the delivery
        // form needs rethinking.
        navigationType: nav ? nav.type : "unknown",
        // Page-world assertion: in an isolated world we would be wrapping a
        // different global and would observe nothing while looking healthy.
        pageWorld: W !== window || typeof unsafeWindow !== "undefined",
        wrapperInstalled: W.WebSocket !== NativeWebSocket,
        // T007: are we inside a frame?
        isTopFrame: W.top === W.self,
        readyState: document.readyState,
        ua: navigator.userAgent,
      }),
    });
    // T006 continued: catch an SPA transition into the draft room.
    for (const m of ["pushState", "replaceState"]) {
      const orig = W.history[m];
      W.history[m] = function () {
        try {
          record({ transport: "meta", event: "spa-nav", url: redact(arguments[2]), data: m });
        } catch { /* ignore */ }
        return orig.apply(this, arguments);
      };
    }
  } catch { /* observations are best-effort */ }

  // --- persistence: a draft runs an hour and the tab may reload ---
  try {
    const prior = GM_getValue(STORE_KEY, "");
    if (prior) {
      log = JSON.parse(prior);
      seq = log.length ? log[log.length - 1].seq + 1 : 0;
      record({ transport: "meta", event: "restored", data: String(log.length) });
    }
  } catch { /* start fresh */ }

  const persist = () => {
    try {
      GM_setValue(STORE_KEY, JSON.stringify(log));
    } catch { /* over quota — the in-memory log and manual download remain */ }
  };
  W.addEventListener("beforeunload", persist);
  W.addEventListener("pagehide", persist);
  setInterval(persist, 30000);

  // --- menu commands ---
  function download() {
    const blob = new Blob([JSON.stringify({ captured: new Date().toISOString(), counts, entries: log }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dg-gate0-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  try {
    GM_registerMenuCommand("Draft Genie: download capture", download);
    GM_registerMenuCommand("Draft Genie: show counts", () => {
      alert(`entries: ${log.length}\n${JSON.stringify(counts, null, 2)}`);
    });
    // T005: the plan's one unverified load-bearing claim — does GM_xhr escape
    // ESPN's page CSP? One request settles it.
    GM_registerMenuCommand("Draft Genie: probe CSP (GM_xhr)", () => {
      GM_xmlhttpRequest({
        method: "GET",
        url: "https://draft.neelamjai.com/api/tap/health",
        anonymous: true,
        onload: (r) => {
          record({ transport: "meta", event: "csp-probe", data: `status=${r.status}` });
          alert(`GM_xhr reached Draft Genie: HTTP ${r.status}`);
        },
        onerror: (e) => {
          record({ transport: "meta", event: "csp-probe-failed", data: JSON.stringify(e || {}) });
          alert("GM_xhr FAILED — see capture log. This invalidates the plan's relay transport.");
        },
      });
    });
  } catch { /* menu commands are convenience only */ }

  record({ transport: "meta", event: "installed" });
})();
