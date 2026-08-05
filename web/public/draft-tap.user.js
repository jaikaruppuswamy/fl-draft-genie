// ==UserScript==
// @name         Draft Genie draft tap
// @namespace    https://draft.neelamjai.com/
// @version      0.1.6
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
  var TAP_VERSION = "0.1.6";
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
    return { kind: "unrecognised", verb: safeVerb(verb) };
  }
  var VERB_SHAPE = /^[A-Z][A-Z0-9_]{0,23}$/;
  function safeVerb(raw) {
    return VERB_SHAPE.test(raw) ? raw : `<non-verb:${raw.length}>`;
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
    const b64 = trimmed.slice(5).trim().split(/\s+/)[0] ?? "";
    if (!b64) throw new LedgerFormatError("INIT frame carried no payload");
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
  var FLUSH_TIMEOUT_MS = 15e3;
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
    "draft-finished": "Draft complete. Nothing further to send.",
    "draft-end-unknown": "The draft room has gone quiet and this tap cannot confirm the draft finished \u2014 it never saw a complete pick list. If the draft is over, nothing is wrong. If it is not, reload the draft room."
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
  function sharesRealmWithUs(other) {
    const Ctor = other?.Object;
    if (typeof Ctor !== "function") return false;
    if (Ctor === Object) return true;
    try {
      return new Ctor() instanceof Object;
    } catch {
      return false;
    }
  }
  function provePageWorld(scope, wrapped, probe) {
    if (wrapped.length === 0) return { pageWorld: false, reason: "no transport constructor was wrapped" };
    const page = probe?.pageGlobal;
    if (!page) {
      return {
        pageWorld: false,
        reason: "no page global available (unsafeWindow not granted) \u2014 cannot prove the page will use our wrapper"
      };
    }
    if (page !== scope) {
      return { pageWorld: false, reason: "wrapper was installed on a different global than the page's" };
    }
    const names = [
      ["WebSocket", "ws"],
      ["EventSource", "sse"]
    ];
    for (const [name, transport] of names) {
      if (!wrapped.includes(transport)) continue;
      if (!isWrapped(page[name])) {
        return { pageWorld: false, reason: `${name} on the page global is not our wrapper` };
      }
    }
    const self = probe?.selfGlobal;
    if (self && page !== self && sharesRealmWithUs(page)) {
      return {
        pageWorld: false,
        reason: "page global is a same-realm object distinct from window \u2014 not a real page handle"
      };
    }
    return { pageWorld: true };
  }
  function install(scope, hooks, probe) {
    const addEL = scope.EventTarget?.prototype.addEventListener;
    if (!addEL) {
      hooks.onError?.("no EventTarget in scope \u2014 cannot observe");
      return { wrapped: [], pageWorld: false, reason: "no EventTarget in scope" };
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
    return { wrapped, ...provePageWorld(scope, wrapped, probe) };
  }

  // tap/draftEnd.ts
  var IDLE_UNCERTAIN_MS = 10 * 60 * 1e3;
  var DraftEnd = class {
    constructor(ports, idleMs = IDLE_UNCERTAIN_MS) {
      this.ports = ports;
      this.idleMs = idleMs;
    }
    seen = /* @__PURE__ */ new Set();
    total = 0;
    over = false;
    timer = null;
    /** FR-024: once true, the tap stops relaying picks. */
    get finished() {
      return this.over;
    }
    get seenCount() {
      return this.seen.size;
    }
    /** 0 means "not yet known" — never treated as a total. */
    get totalSlots() {
      return this.total;
    }
    /**
     * Record picks from either source. `total` is supplied only by the ledger.
     *
     * Identity is the player id (FR-005a): the same value in both sources, and
     * NOT the field US1 exists to disambiguate, which US1 did not resolve.
     */
    notePicks(playerIds, total) {
      if (typeof total === "number" && total > 0) this.total = total;
      for (const id of playerIds) this.seen.add(id);
      this.armIdle();
      if (this.over || this.total <= 0 || this.seen.size < this.total) return;
      this.over = true;
      this.clear();
      this.ports.render("draft-finished", `${this.seen.size}/${this.total} picks`);
      this.ports.flush();
    }
    /** Should this frame still be relayed? */
    shouldRelay(kind) {
      return !this.over || kind === "status";
    }
    /**
     * A quiet room is ambiguous — ended, paused, or a dead stream all look
     * identical. SC-014 forbids letting idle and dead read the same, so after a
     * long silence with picks seen but no confirmed completion, say so.
     */
    armIdle() {
      this.clear();
      if (this.over) return;
      this.timer = this.ports.setTimer(() => {
        if (this.over || this.seen.size === 0) return;
        const s = this.ports.currentState();
        if (s === "incompatible" || s === "version-rejected") return;
        this.ports.render("draft-end-unknown", `${this.seen.size}/${this.total || "?"} picks, then silence`);
      }, this.idleMs);
    }
    clear() {
      if (this.timer !== null) {
        this.ports.clearTimer(this.timer);
        this.timer = null;
      }
    }
  };

  // tap/heartbeat.ts
  var HEARTBEAT_MS = 15e3;
  var HEARTBEAT_MIN_GAP_MS = 5e3;
  function shouldSendHeartbeat(i) {
    if (!i.paired) return { send: false, reason: "not-paired" };
    if (i.lastSentAt === null) return { send: true, reason: "first" };
    const since = i.now - i.lastSentAt;
    if (since < HEARTBEAT_MIN_GAP_MS) return { send: false, reason: "too-soon" };
    if (i.triggeredByEvent) return { send: true, reason: "event" };
    return since >= HEARTBEAT_MS ? { send: true, reason: "due" } : { send: false, reason: "too-soon" };
  }

  // tap/main.ts
  var W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var NATIVE_TO_STRING = Function.prototype.toString;
  function captureNative(fn) {
    try {
      if (typeof fn !== "function") return null;
      return NATIVE_TO_STRING.call(fn).includes("[native code]") ? fn : null;
    } catch {
      return null;
    }
  }
  var PAGE_PROMPT = captureNative(W.prompt);
  var PAGE_ALERT = captureNative(W.alert);
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
  var lastReportedState = null;
  var GUID_ANY = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g;
  function scrubDetail(detail) {
    return detail.replace(/https?:\/\/\S+/g, "<url>").replace(GUID_ANY, "<id>").replace(/\{[0-9A-Fa-f-]{20,}\}/g, "<id>");
  }
  function render(state, detail = "") {
    const changed = state !== status.state;
    status.state = state;
    status.detail = detail;
    if (changed) reportStatus(state, detail);
    if (!badge) return;
    const safe = scrubDetail(detail);
    badge.textContent = `Draft Genie ${TAP_VERSION}: ${state}${safe ? ` \u2014 ${safe}` : ""}`;
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
  var league = { espnLeagueId: "", season: 0 };
  var sequencer = new Sequencer(clock, installId(), SESSION, league);
  var buffer = new Buffer(gmStorage, installId(), SESSION);
  var failures = 0;
  var flushing = false;
  var flushWatchdog = null;
  function endFlush() {
    flushing = false;
    if (flushWatchdog !== null) {
      clearTimeout(flushWatchdog);
      flushWatchdog = null;
    }
  }
  function token() {
    return GM_getValue("dg:token", "");
  }
  function flush() {
    if (flushing || !token()) return;
    const pending = buffer.pending();
    if (!pending.length) return;
    flushing = true;
    flushWatchdog = setTimeout(() => {
      endFlush();
      failures++;
      render("buffering", "no response from Draft Genie");
      scheduleRetry();
    }, FLUSH_TIMEOUT_MS);
    const batch = chunk(pending)[0];
    try {
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
          // Deliberately omitted: the Worker resolves the connection from the ESPN
          // league id and season, both of which the draft-room URL gives us. The
          // tap has no way to learn Draft Genie's internal UUID.
          messages: batch
        }),
        onload: (r) => {
          endFlush();
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
        }
      });
    } catch (e) {
      endFlush();
      failures++;
      render("buffering", `relay failed: ${e.message}`);
      scheduleRetry();
    }
  }
  function reportStatus(state, detail) {
    if (!token() || state === lastReportedState) return;
    lastReportedState = state;
    postStatus(state, detail, false);
  }
  var lastHeartbeatAt = null;
  function heartbeat(triggeredByEvent) {
    const decision = shouldSendHeartbeat({
      now: clock.now(),
      lastSentAt: lastHeartbeatAt,
      paired: Boolean(token()),
      triggeredByEvent
    });
    if (!decision.send) return;
    lastHeartbeatAt = clock.now();
    postStatus(status.state, status.detail, true);
  }
  function postStatus(state, detail, isHeartbeat) {
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
          league: { espnLeagueId: league.espnLeagueId, season: league.season }
        })
      });
    } catch {
    }
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
        try {
          const ledger = decodeInitFrame(raw, W.atob.bind(W));
          if (ledger) {
            const picks = filledPicks(ledger);
            enqueue("ledger", picks.map(filterLedgerPick), transport);
            draftEnd.notePicks(picks.map((p) => p.playerId), ledger.totalSlots);
          }
        } catch (e) {
          status.unrecognisedCount++;
          render("incompatible", `ledger: ${e.message}`);
        }
        return;
      }
      case "known-non-draft":
        if (c.verb === "STATE") onDraftState(raw);
        return;
      // silently dropped, by design
      case "unrecognised":
        status.unrecognisedCount++;
        render("incompatible", `unknown message "${c.verb}"`);
        enqueue("status", { state: "incompatible", verb: c.verb }, transport);
        return;
    }
  }
  var draftEnd = new DraftEnd({
    render: (state, detail) => render(state, detail),
    flush: () => flush(),
    currentState: () => status.state,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h)
  });
  function onDraftState(raw) {
    const phase = Number(raw.replace(/\n$/, "").split(" ")[1] ?? NaN);
    if (Number.isFinite(phase)) render(status.state, `draft phase ${phase}`);
  }
  function start() {
    const result = install(
      W,
      {
        isDraftChannel,
        onFrame: (raw, transport) => onFrame(raw, transport),
        onChannel: (event) => {
          if (event === "open") render(token() ? "watching" : "not-paired");
        },
        onError: (m) => render("incompatible", m)
      },
      // The probe must reach the page global INDEPENDENTLY of the scope we
      // installed on, or it can only confirm its own assumption. `unsafeWindow`
      // is that independent handle; `window` is what our own code sees, and the
      // relationship between the two is what distinguishes page-context
      // injection from a script-manager sandbox.
      {
        pageGlobal: typeof unsafeWindow !== "undefined" ? unsafeWindow : null,
        selfGlobal: typeof window !== "undefined" ? window : null
      }
    );
    if (!result.pageWorld) {
      render("incompatible", `could not attach to the page \u2014 picks are NOT being captured (${result.reason})`);
      return;
    }
    const params = new URLSearchParams(W.location.search);
    league.espnLeagueId = params.get("leagueId") ?? "";
    league.season = Number(params.get("seasonId") ?? (/* @__PURE__ */ new Date()).getFullYear());
    W.addEventListener("DOMContentLoaded", mountBadge);
    if (W.document.readyState !== "loading") mountBadge();
    for (const ev of ["online", "pageshow", "focus"]) {
      W.addEventListener(ev, () => {
        sequencer.reanchor();
        flush();
        heartbeat(true);
      });
    }
    W.document.addEventListener("visibilitychange", () => {
      heartbeat(true);
      if (!W.document.hidden) {
        sequencer.reanchor();
        flush();
      }
    });
    setInterval(() => heartbeat(false), HEARTBEAT_MS);
    heartbeat(false);
    render(token() ? "watching" : "not-paired");
    GM_registerMenuCommand("Draft Genie: status", () => {
      const text = `${status.state}

${EXPLANATIONS[status.state]}

buffered: ${status.buffered}
unrecognised: ${status.unrecognisedCount}
picks seen: ${draftEnd.seenCount}/${draftEnd.totalSlots || "?"}
version: ${TAP_VERSION}`;
      if (PAGE_ALERT) PAGE_ALERT.call(W, text);
      else render(status.state, "cannot display status \u2014 the page replaced alert()");
    });
    GM_registerMenuCommand("Draft Genie: paste pairing token", () => {
      if (!PAGE_PROMPT) {
        render(
          status.state,
          "cannot accept a token on this page \u2014 prompt() was replaced. Pair from Draft Genie instead."
        );
        return;
      }
      const t = PAGE_PROMPT.call(W, "Paste the pairing token from Draft Genie settings:");
      if (t) {
        GM_setValue("dg:token", String(t).trim());
        render("watching");
        flush();
      }
    });
  }
  start();
})();
