// ==UserScript==
// @name         Draft Genie draft tap
// @namespace    https://draft.neelamjai.com/
// @version      0.1.0
// @description  Passively relays your own ESPN draft-room picks to Draft Genie. Opens nothing to ESPN and sends nothing to ESPN.
// @author       Draft Genie
// @match        https://fantasy.espn.com/football/draft*
// @run-at       document-start
// @sandbox      raw
// @inject-into  page
// @noframes
// @connect      draft.neelamjai.com
// @updateURL    https://draft.neelamjai.com/draft-tap.user.js
// @downloadURL  https://draft.neelamjai.com/draft-tap.user.js
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==
"use strict";
(() => {
  // tap/meta.ts
  var TAP_VERSION = "0.1.0";
  var CONTRACT_VERSION = 1;
  var INGEST_ORIGIN = "https://draft.neelamjai.com";
  var DRAFT_HOST = "fantasydraft.espn.com";
  var IGNORED_HOSTS = ["espn.connections.edge.bamgrid.com"];
  var META_BLOCK = `// ==UserScript==
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

  // tap/classify.ts
  var KNOWN_NON_DRAFT = /* @__PURE__ */ new Set([
    "PONG",
    "CLOCK",
    "SELECTING",
    "AUTOSUGGEST",
    "AUTODRAFT",
    "JOINED",
    "LEFT",
    "TOKEN",
    "STATE",
    "CHAT",
    "ACL"
  ]);
  function isDraftChannel(url) {
    let host;
    try {
      host = new URL(url, "https://fantasy.espn.com").hostname;
    } catch {
      return false;
    }
    if (IGNORED_HOSTS.includes(host)) return false;
    return host === DRAFT_HOST;
  }
  var normalise = (raw) => raw.replace(/\n$/, "");
  function classify(raw) {
    const text = normalise(raw);
    const verb = text.split(" ", 1)[0] ?? "";
    if (verb === "SELECTED") {
      return { kind: "pick", verb, fields: text.split(" ").slice(1) };
    }
    if (verb === "INIT") {
      return { kind: "ledger", verb, payload: text.slice(5).trim() };
    }
    if (KNOWN_NON_DRAFT.has(verb)) return { kind: "known-non-draft", verb };
    return { kind: "unrecognised", verb: verb.slice(0, 32) };
  }

  // tap/decode.ts
  var RECORD_STRIDE = 45;
  var OFF_TEAM = 0;
  var OFF_OVERALL = 4;
  var OFF_PLAYER = 8;
  var OFF_SLOT3 = 12;
  var EMPTY_PLAYER_ID = -1;
  var LedgerFormatError = class extends Error {
    constructor(message) {
      super(`ledger format: ${message}`);
      this.name = "LedgerFormatError";
    }
  };
  function readI32(view, offset) {
    if (offset < 0 || offset + 4 > view.byteLength) {
      throw new LedgerFormatError(`read past end at ${offset} (length ${view.byteLength})`);
    }
    return view.getInt32(offset, false);
  }
  function decodeLedger(bytes, opts = {}) {
    const minSlots = opts.minSlots ?? 12;
    if (bytes.byteLength < RECORD_STRIDE * minSlots) {
      throw new LedgerFormatError(`too short: ${bytes.byteLength} bytes`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let best = { offset: -1, count: 0 };
    for (let start2 = 0; start2 + RECORD_STRIDE * minSlots <= bytes.byteLength; start2++) {
      if (readI32(view, start2 + OFF_OVERALL) !== 1) continue;
      let count = 1;
      for (; ; ) {
        const next = start2 + count * RECORD_STRIDE;
        if (next + RECORD_STRIDE > bytes.byteLength) break;
        if (readI32(view, next + OFF_OVERALL) !== count + 1) break;
        count++;
      }
      if (count > best.count) best = { offset: start2, count };
    }
    if (best.count < minSlots) {
      throw new LedgerFormatError(
        `no pick array found (longest run ${best.count} < ${minSlots}) \u2014 ESPN's ledger layout may have changed`
      );
    }
    const slots = [];
    for (let n = 0; n < best.count; n++) {
      const at = best.offset + n * RECORD_STRIDE;
      const playerId = readI32(view, at + OFF_PLAYER);
      slots.push(
        playerId === EMPTY_PLAYER_ID ? null : {
          teamId: readI32(view, at + OFF_TEAM),
          overallPickNumber: readI32(view, at + OFF_OVERALL),
          playerId,
          slot3: readI32(view, at + OFF_SLOT3)
        }
      );
    }
    return { slots, arrayOffset: best.offset, totalSlots: best.count };
  }
  function filledPicks(ledger) {
    return ledger.slots.filter((s) => s !== null);
  }
  function decodeInitFrame(frame, atob) {
    const trimmed = frame.replace(/\n$/, "");
    if (!trimmed.startsWith("INIT ")) return null;
    const b64 = trimmed.slice(5).trim();
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return decodeLedger(bytes);
  }

  // tap/filter.ts
  function filterPickFields(fields) {
    if (fields.length < 3) return null;
    const [team, player, third] = fields;
    const teamId = Number(team);
    const playerId = Number(player);
    const slot3 = Number(third);
    if (!Number.isInteger(teamId) || !Number.isInteger(playerId) || !Number.isInteger(slot3)) return null;
    return { teamId, playerId, slot3 };
  }
  function filterLedgerPick(p) {
    return {
      teamId: p.teamId,
      playerId: p.playerId,
      slot3: p.slot3,
      overallPickNumber: p.overallPickNumber
    };
  }
  var GUID = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/;
  function assertTransmittable(value) {
    const json = JSON.stringify(value ?? null);
    if (GUID.test(json)) throw new Error("refusing to transmit: value contains a GUID");
    const strings = json.match(/"[^"]*"/g) ?? [];
    for (const s of strings) {
      if (/https?:\/\//.test(s)) throw new Error("refusing to transmit: value contains a URL");
    }
  }

  // tap/batch.ts
  var MAX_BATCH = 200;
  var EPOCH_DRIFT_MS = 2e3;
  var Sequencer = class {
    constructor(clock2, install2, session, league2) {
      this.clock = clock2;
      this.install = install2;
      this.session = session;
      this.league = league2;
      this.anchorWall = clock2.now();
      this.anchorMono = clock2.monotonic();
    }
    seq = 0;
    epoch = 0;
    anchorWall;
    anchorMono;
    /** Call on resume/pageshow/online. Bumps the epoch if the clock actually moved. */
    reanchor() {
      const wall = this.clock.now();
      const mono = this.clock.monotonic();
      const drift = Math.abs(wall - this.anchorWall - (mono - this.anchorMono));
      this.anchorWall = wall;
      this.anchorMono = mono;
      if (drift > EPOCH_DRIFT_MS) {
        this.epoch++;
        return true;
      }
      return false;
    }
    currentEpoch() {
      return this.epoch;
    }
    build(kind, payload, transport) {
      return {
        v: CONTRACT_VERSION,
        tapVersion: TAP_VERSION,
        install: this.install,
        session: this.session,
        seq: this.seq++,
        epoch: this.epoch,
        observedAt: new Date(this.clock.now()).toISOString(),
        transport,
        league: this.league,
        kind,
        payload
      };
    }
  };
  function chunk(messages, max = MAX_BATCH) {
    const out = [];
    for (let i = 0; i < messages.length; i += max) out.push(messages.slice(i, i + max));
    return out;
  }
  function backoffMs(consecutiveFailures, retryAfterSeconds) {
    if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1e3, 6e4);
    return Math.min(1e3 * 2 ** Math.max(0, consecutiveFailures - 1), 3e4);
  }

  // tap/buffer.ts
  var MAX_BUFFERED = 2e3;
  var Buffer = class {
    constructor(storage, install2, session) {
      this.storage = storage;
      this.key = `dg:buf:${install2}:${session}`;
      this.items = this.load();
    }
    key;
    items;
    load() {
      try {
        const raw = this.storage.get(this.key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    persist() {
      try {
        this.storage.set(this.key, JSON.stringify(this.items));
      } catch {
      }
    }
    append(message) {
      this.items.push(message);
      if (this.items.length > MAX_BUFFERED) this.items = this.items.slice(-MAX_BUFFERED);
      this.persist();
    }
    pending() {
      return [...this.items];
    }
    size() {
      return this.items.length;
    }
    /** Remove everything up to and including `acceptedThrough`. Ack-driven only. */
    truncate(acceptedThrough) {
      const before = this.items.length;
      this.items = this.items.filter((m) => m.seq > acceptedThrough);
      if (this.items.length !== before) this.persist();
      return before - this.items.length;
    }
    clear() {
      this.items = [];
      this.storage.remove(this.key);
    }
  };

  // tap/status.ts
  var EXPLANATIONS = {
    "not-paired": "Not linked to Draft Genie yet. Open Draft Genie settings and pair this browser.",
    paired: "Linked, waiting for a draft room.",
    "not-a-draft-page": "This is not an ESPN draft room, so nothing is being watched.",
    watching: "Draft room open, waiting for picks.",
    relaying: "Sending picks to Draft Genie.",
    buffering: "Cannot reach Draft Genie \u2014 picks are being saved and will be sent when it returns.",
    "version-rejected": "Draft Genie does not understand this version of the tap. Update it.",
    incompatible: "ESPN's draft messages no longer match what this tap understands, or it could not attach to the page. Picks are NOT being captured \u2014 update the tap.",
    "draft-finished": "Draft complete. Nothing further to send."
  };
  function isDegraded(status2) {
    return status2.unrecognisedCount > 0 || status2.state === "incompatible" || status2.state === "version-rejected" || status2.state === "buffering";
  }

  // tap/intercept.ts
  var IS_WRAPPED = Symbol.for("draft-genie.tap.wrapped");
  function isWrapped(ctor) {
    return typeof ctor === "function" && ctor[IS_WRAPPED] === true;
  }
  function wrapConstructor(Native, transport, hooks, addEventListener) {
    if (isWrapped(Native)) return Native;
    const defer = hooks.defer ?? ((fn) => setTimeout(fn, 0));
    const proxy = new Proxy(Native, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        try {
          const url = String(args[0] ?? "");
          if (!hooks.isDraftChannel(url)) return instance;
          addEventListener.call(instance, "message", (ev) => {
            const data = ev.data;
            defer(() => {
              try {
                if (typeof data === "string") hooks.onFrame(data, transport, url);
              } catch (e) {
                hooks.onError?.(`frame handler: ${e.message}`);
              }
            });
          });
          for (const kind of ["open", "close"]) {
            addEventListener.call(instance, kind, () => {
              try {
                hooks.onChannel?.(kind, transport, url);
              } catch {
              }
            });
          }
        } catch (e) {
          try {
            hooks.onError?.(`wrapper: ${e.message}`);
          } catch {
          }
        }
        return instance;
      },
      get(target, prop, receiver) {
        if (prop === IS_WRAPPED) return true;
        return Reflect.get(target, prop, receiver);
      }
    });
    return proxy;
  }
  function install(scope, hooks) {
    const addEL = scope.EventTarget?.prototype.addEventListener;
    if (!addEL) {
      hooks.onError?.("no EventTarget in scope \u2014 cannot observe");
      return { wrapped: [], pageWorld: false };
    }
    const wrapped = [];
    for (const [name, transport] of [
      ["WebSocket", "ws"],
      ["EventSource", "sse"]
    ]) {
      const native = scope[name];
      if (typeof native !== "function") continue;
      try {
        const proxy = wrapConstructor(native, transport, hooks, addEL);
        scope[name] = proxy;
        if (isWrapped(scope[name])) wrapped.push(transport);
      } catch (e) {
        hooks.onError?.(`install ${name}: ${e.message}`);
      }
    }
    return { wrapped, pageWorld: wrapped.length > 0 };
  }

  // tap/main.ts
  var W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var gmStorage = {
    get: (k) => GM_getValue(k, "") || null,
    set: (k, v) => GM_setValue(k, v),
    remove: (k) => GM_deleteValue(k)
  };
  var clock = { now: () => Date.now(), monotonic: () => performance.now() };
  function installId() {
    let id = GM_getValue("dg:install", "");
    if (!id) {
      id = crypto.randomUUID();
      GM_setValue("dg:install", id);
    }
    return id;
  }
  var SESSION = crypto.randomUUID();
  var status = {
    state: "not-paired",
    tapVersion: TAP_VERSION,
    lastRelayedAt: null,
    buffered: 0,
    unrecognisedCount: 0,
    detail: ""
  };
  var badge = null;
  function render(state, detail = "") {
    status.state = state;
    status.detail = detail;
    if (!badge) return;
    badge.textContent = `Draft Genie: ${state}${detail ? ` \u2014 ${detail}` : ""}`;
    badge.style.background = isDegraded(status) ? "#7a2020" : "#20502a";
    badge.title = EXPLANATIONS[state];
  }
  function mountBadge() {
    badge = W.document.createElement("div");
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "8px",
      left: "8px",
      zIndex: "2147483647",
      font: "12px system-ui, sans-serif",
      color: "#fff",
      padding: "4px 8px",
      borderRadius: "4px",
      pointerEvents: "none",
      opacity: "0.85"
    });
    W.document.body?.appendChild(badge);
    render(status.state);
  }
  var league = { espnLeagueId: "", season: 0, connectionId: "" };
  var sequencer = new Sequencer(clock, installId(), SESSION, league);
  var buffer = new Buffer(gmStorage, installId(), SESSION);
  var failures = 0;
  var flushing = false;
  function token() {
    return GM_getValue("dg:token", "");
  }
  function flush() {
    if (flushing || !token()) return;
    const pending = buffer.pending();
    if (!pending.length) return;
    flushing = true;
    const batch = chunk(pending)[0];
    GM_xmlhttpRequest({
      method: "POST",
      url: `${INGEST_ORIGIN}/api/tap/batch`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, "X-Tap-Install": installId() },
      anonymous: true,
      // documented: "don't send cookies with the request"
      data: JSON.stringify({
        v: CONTRACT_VERSION,
        install: installId(),
        session: SESSION,
        league: { espnLeagueId: league.espnLeagueId, season: league.season },
        connectionId: league.connectionId,
        messages: batch
      }),
      onload: (r) => {
        flushing = false;
        if (r.status === 202) {
          failures = 0;
          try {
            const body = JSON.parse(r.responseText);
            if (typeof body.accepted_through === "number") buffer.truncate(body.accepted_through);
          } catch {
          }
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
      }
    });
  }
  function scheduleRetry(responseHeaders) {
    const retryAfter = /retry-after:\s*(\d+)/i.exec(responseHeaders ?? "")?.[1];
    setTimeout(flush, backoffMs(failures, retryAfter ? Number(retryAfter) : void 0));
  }
  function enqueue(kind, payload, transport) {
    assertTransmittable(payload);
    const msg = sequencer.build(kind, payload, transport);
    buffer.append(msg);
    status.buffered = buffer.size();
    flush();
  }
  function onFrame(raw, transport) {
    const c = classify(raw);
    switch (c.kind) {
      case "pick": {
        const payload = filterPickFields(c.fields);
        if (payload) enqueue("pick", payload, transport);
        return;
      }
      case "ledger": {
        try {
          const ledger = decodeInitFrame(raw, W.atob.bind(W));
          if (ledger) enqueue("ledger", filledPicks(ledger).map(filterLedgerPick), transport);
        } catch (e) {
          status.unrecognisedCount++;
          render("incompatible", `ledger: ${e.message}`);
        }
        return;
      }
      case "known-non-draft":
        return;
      // silently dropped, by design
      case "unrecognised":
        status.unrecognisedCount++;
        render("incompatible", `unknown message "${c.verb}"`);
        enqueue("status", { state: "incompatible", verb: c.verb }, transport);
        return;
    }
  }
  function start() {
    const result = install(W, {
      isDraftChannel,
      onFrame: (raw, transport) => onFrame(raw, transport),
      onChannel: (event) => {
        if (event === "open") render(token() ? "watching" : "not-paired");
      },
      onError: (m) => render("incompatible", m)
    });
    if (!result.pageWorld) {
      render("incompatible", "could not attach to the page \u2014 picks are NOT being captured");
      return;
    }
    const params = new URLSearchParams(W.location.search);
    league.espnLeagueId = params.get("leagueId") ?? "";
    league.season = Number(params.get("seasonId") ?? (/* @__PURE__ */ new Date()).getFullYear());
    league.connectionId = GM_getValue(`dg:conn:${league.espnLeagueId}`, "");
    W.addEventListener("DOMContentLoaded", mountBadge);
    if (W.document.readyState !== "loading") mountBadge();
    for (const ev of ["online", "pageshow", "focus"]) {
      W.addEventListener(ev, () => {
        sequencer.reanchor();
        flush();
      });
    }
    W.document.addEventListener("visibilitychange", () => {
      if (!W.document.hidden) {
        sequencer.reanchor();
        flush();
      }
    });
    render(token() ? "watching" : "not-paired");
    GM_registerMenuCommand("Draft Genie: status", () => {
      W.alert(`${status.state}

${EXPLANATIONS[status.state]}

buffered: ${status.buffered}
version: ${TAP_VERSION}`);
    });
    GM_registerMenuCommand("Draft Genie: paste pairing token", () => {
      const t = W.prompt("Paste the pairing token from Draft Genie settings:");
      if (t) {
        GM_setValue("dg:token", t.trim());
        render("watching");
        flush();
      }
    });
  }
  start();
})();
