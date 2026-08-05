# Research: Draft Tap (010)

Claims below were derived by **reading ESPN's own shipped draft client** (a
public, minified JS bundle) and by **running the interception mechanism in real
Chrome 148**, not from third-party write-ups. Where something could not be
verified against primary documentation it is marked **UNVERIFIED** and carries a
cheap US1 experiment to settle it.

A capture shows what happened once; the bundle states what the client does in
every branch. That distinction is why several prior claims are corrected here.

---

## 0. Transport: WebSocket **first**, SSE **fallback** — wrap both

**Decision**: Wrap **both** `WebSocket` and `EventSource` with a
construct-trap `Proxy`, scoped by URL to the draft-room host.

**This corrects 005 research §0**, which described "an SSE transport" while also
citing taps that wrap `window.WebSocket`. Both described real code paths; the
relationship is primary/fallback:

- `getHost()` → `fantasydraft.<espn|espnqa>.com/game-<g>/`
- `openSocketConnection()` prefixes `wss://`; `openSSEConnection()` appends
  `/sse` and prefixes `https://`
- Selector: `(attempts.socket < (attempts.sse+1)*ratio || force==="socket") && force!=="sse"`,
  with `ratio = 1` and both counters at 0 → **attempt 1 is always WebSocket**
- `socketToSSERatio *= 0.5` on socket failure, so **attempt 2 goes to SSE**.
  With `connectTimeoutDuration = 4000` and `reconnectInterval = 3000`, ordinary
  bad network reaches SSE in **~7 seconds**

**Consequence**: every public tap implementation is WebSocket-only, and
therefore **goes dark exactly when the user's network is worst** — a latent
FR-017 silent failure. Wrapping both is not belt-and-braces; it is the
difference between working and not on a bad hotel connection during a draft.

**Normalisation differs by transport** (reproduced in Chrome): the raw WS frame
arrives as `"SELECTED 1 2 3\n"`, the SSE frame as `"SELECTED 1 2 3"` — ESPN
applies `e.data.slice(0, e.data.length-1)` on the WS path only. The tap must
normalise, and the contract must record which transport produced a frame.

---

## 1. The wrapper: shape that cannot break the user's draft

**Decision**: `new Proxy(Native, { construct })`, **URL-scoped**, calling
`Reflect.construct(target, args, newTarget)`, attaching observation via a saved
`addEventListener` reference, everything in `try/catch`. Never touch `send`,
`onmessage`, `binaryType`, `close`, `fetch` or `XMLHttpRequest`.

Three findings here are load-bearing, and two would have broken the draft:

**MUST forward `newTarget`.** `Reflect.construct(target, args)` **without** the
third argument silently destroys subclassing — verified: `class C extends
EventSource` loses its own methods. If ESPN's client subclasses its transport,
the tap breaks the draft in the one way FR-002/SC-004 forbid. With `newTarget`
forwarded, `instanceof`, statics, prototype identity, `onmessage` and
subclassing all survive.

**MUST scope by URL.** ESPN's commons bundle (~9.1 MB) constructs a **second,
unrelated** `WebSocket` on the same page — a `SocketManager` with JSON envelopes
and auth frames. An unscoped wrapper would relay its traffic (breaching
FR-006/FR-006a) *and* feed its JSON to the draft decoder, firing FR-017a's
unrecognised counter continuously — the exact false alarm FR-017a exists to
prevent. Gate on the constructor's URL hostname.

**MUST try/catch the trap and the listener.** A throw anywhere in the construct
trap propagates to the page's `new` — verified, both before and after
`Reflect.construct`. ESPN's own `catch { openSSEConnection() }` would be
triggered by our bug. A throwing listener does not stop the page's other
listeners but does raise an uncaught error into ESPN's page.

**Ordering, verified in Chrome**: with ESPN's exact call pattern (construct,
then assign `.onmessage` on the next line), the page's handler fires **first**
and the tap second, on both transports. ESPN is never delayed and no frame is
missed. But use `setTimeout(…, 0)` rather than `queueMicrotask` to defer decode
work — microtasks drain before the event loop yields, so a microtask is still on
ESPN's critical path.

**Honest limit**: `Proxy !== NativeWebSocket`, so identity *is* observable to
code holding a pre-captured reference. ESPN does not do this (the token
`WebSocket` appears exactly once in the draft bundle, at the `new` site). State
this as "not detectable by anything ESPN does", never as "undetectable".

---

## 2. Decoding the ledger — do **not** port ESPN's reader

**Decision**: write our own bounds-checked, version-asserting reader modelled on
ESPN's transcoder tree.

**ESPN's own `readDouble()`/`readFloat()` discard the bytes and return
`1e3*Math.random()` / `100*Math.random()`.** Five real fields flow through them.
Byte *advance* stays deterministic (`readNumber(8)`/`readNumber(4)`), so offsets
are safe — but ESPN's client displays garbage for those fields, `readNumber(8)`
is not IEEE-754 decoding at all, and **anyone porting ESPN's reader inherits the
bug silently**. This kills "use ESPN's decoder as ground truth" for every
non-integer field.

**Favourable finding for FR-006c**: `readUTF()` is defined but **never called**
anywhere in the 19-transcoder tree. The ledger blob contains **zero strings** —
names and brace-form SWIDs cannot be in it. Its identity exposure is numeric
member ids only. Names and SWIDs live only in the **text** protocol
(CHAT/JOINED/LEFT/ACL), which FR-006 discards wholesale. This makes the FR-006a
allowlist materially easier to prove.

---

## 3. Secrets hiding in plain sight

**The draft-room URL carries the owner's SWID.** `this.userProfileId =
a.memberId`, where `memberId` is a URL query parameter — and unlike
`leagueId`/`seasonId`/`teamId` it is **not** `Number()`-coerced. That value
becomes the socket's `4=` parameter.

**Therefore**: the tap MUST never relay `location.href`, and MUST redact it in
status, diagnostics and any error report. This is the third time this defect
class has appeared in this project (005's fixture capture, 010's raw discovery
capture, now the page URL) and it is recorded here so it is not rediscovered a
fourth time.

Note the ledger's `userProfileId` fields are `readInt()` **numbers** — a
different identifier space from the brace-form SWID. US1 must record which is
which; both are forbidden by FR-006a regardless.

---

## 4. Userscript mechanics

**Decision**: single-file userscript, `@run-at document-start`, page world via
`@sandbox raw` (Tampermonkey) + `@inject-into page` (Violentmonkey), a
**non-empty** `@grant` list including `unsafeWindow`, GM storage,
`GM_xmlhttpRequest` and `GM_registerMenuCommand`. Hosted at
`https://draft.neelamjai.com/draft-tap.user.js`.

**Page world is not guaranteed** *(the decision's single point of failure)*.
Tampermonkey's `@sandbox raw` docs say it falls back "to other enabled
sandboxes" when MAIN-world injection is not feasible, "such as due to Content
Security Policy restrictions". In an isolated world `window.WebSocket` is not
the page's, and **the tap silently observes nothing** — precisely the FR-017
failure it must never have. **UNVERIFIED**: no primary doc states that
`@sandbox raw` combined with a non-empty `@grant` reliably yields MAIN world.

**Mitigation, mandatory**: a startup preflight that asserts *page-world
membership* — not merely that the global is non-native — and reports loudly
under FR-017 if it fails.

**Named supported configuration (FR-023)**: Chrome ≥ 138 with Tampermonkey's
**"Allow user scripts" toggle ON** — it defaults **OFF** for new installs, and
`chrome.userScripts` is undefined without it. Also: **no `@require`**, which is
documented to delay injection past document-start.

**SPA navigation is the highest-value open question after the protocol.**
`/football/draft` is a Next.js route. If the draft room can be entered by
client-side navigation from another `fantasy.espn.com` page, the document never
reloads and a `document-start` userscript is **never injected** — the owner sees
no indicator at all. One observation during US1 settles it.

**Update path**: `@version` + `@updateURL`/`@downloadURL` work, but managers
check on **their** schedule and neither exposes a force-check API. FR-022's
"minutes" therefore requires a documented manual force-update step in the
install guide, not just the metadata.

---

## 5. Relay transport and the pairing credential

**Decision**: `GM_xmlhttpRequest` with `@connect draft.neelamjai.com` (never
`@connect *`) and `anonymous: true` on every call — documented verbatim as
"don't send cookies with the request". The response object exposes
status/headers/body, so FR-016 can distinguish 401 from 409 from unreachable,
and `Retry-After` is readable without `Access-Control-Expose-Headers`.

Rejected: `sendBeacon` (no response access — MDN's own text; and it **cannot
carry custom headers**, so the credential would land in the body or a cookie);
`fetch(keepalive)` (64 KiB body cap); page `fetch` (CORS-dependent, ambient
cookies).

**UNVERIFIED and load-bearing**: "GM_xhr is exempt from the page's `connect-src`
CSP" is **not documented** by Tampermonkey, and there is a counterexample in the
same product family (Greasemonkey 4 regressed to being blocked). Chrome's
network-requests documentation and Tampermonkey issue traffic both support it
by inference. **Settle with a 10-minute US1 smoke test**: fire one `GM_xhr` from
the real draft-room page to a test route and read the status.

**Credential handling rule**: under `@sandbox raw` the tap shares ESPN's JS
realm. The token is safe at rest in extension storage, but **no function the
page can reach may close over it** — the transport shims must call into the
relay through a module boundary that does not capture the token.

**Worker wiring, three traps**: mount `/api/tap/*` **before**
`app.use("/api/*", …)` at [app.ts:34](src/api/app.ts:34), or a tap POST returns
401 no matter how correct the token is. Hono's CORS *omits* rather than
*rejects* on an unlisted origin — which is what the GM_xhr path needs; do not
"fix" it with a 403 guard. And `src/` has **no Access-Control handling at all**
today, so the preflight is unbuilt and untested.

---

## 6. Not losing picks

**Two mechanisms, explicitly ranked.** Primary: **ESPN's own full ledger**,
re-supplied on every page load and reconnect, recovers anything observed but
undelivered. Secondary: **our durable buffer**, covering the one window the
ledger cannot — picks observed while Draft Genie is unreachable in a tab that is
never reloaded again. Stating the ranking is what makes an occasional lost
buffer write survivable rather than a spec violation.

**Filter *before* buffering** — decode → strip → buffer → send. Buffering the
wire form and stripping on send would write unstripped identifiers to disk,
outliving the tab and invisible to any inspection of transmitted traffic. Same
defect class as §3.

**Buffer lives in script-manager storage**, keyed per relay session, **not** in
`espn.com` localStorage/IndexedDB — that is ESPN's own storage bucket, readable
by ESPN's JS and wiped by "clear site data".

**Gotchas that break stated criteria if missed**:
- A `setTimeout` retry chain in a hidden tab is throttled to 1/second, and to
  **1/minute** after 5 chained timers with the tab hidden 5 minutes — that alone
  breaks SC-005's 60-second recovery. Flush must be **event-driven** (next
  message, `online`, `visibilitychange`, `resume`, `pageshow`) with the timer
  only as a backstop.
- `performance.now()` **stalls across sleep** while `Date.now()` jumps forward,
  so a wall-clock stamp anchored at page load runs silently late afterwards.
  Re-anchor on resume, bump a **timing epoch** when the anchor moves > ~2 s, and
  never let 005 compare stamps across epochs as one timeline.
- `sessionStorage` is **cloned when a tab is duplicated**, so a tabId kept there
  is not unique and two live relays would emit colliding sequence numbers. Scope
  `seq` to a fresh per-page-load session id.
- **Never truncate the buffer on an unacknowledged send.** Truncate only on a
  read acknowledgement carrying accepted-through; let FR-010's dedup absorb the
  duplicate.
- **UNKNOWN, required US1 observation**: whether the ESPN draft room self-heals
  and re-emits the ledger on wake from sleep. The tap cannot reconnect ESPN's
  stream itself (FR-001). If it does not self-heal, "resumed but no ledger and
  no message" must become a loud reload prompt — SC-014 forbids idle and dead
  looking the same.

---

## 7. Testing

**Decision**: pure modules behind an injection seam plus a thin impure shell; a
**second Vitest project** (`environment: "node"`) alongside the existing workers
pool in one config; TypeScript bundled with esbuild from a top-level `tap/`; a
`/tap/self-test` replay harness shipped as a product deliverable.

Verified: the two-project config runs the **full existing suite** (33 files, 146
tests, workers pool, D1 migrations) plus the node project in one `vitest run`,
and `--project tap` filters. Browser-side tap code cannot run under the workers
pool, which is why the split is required rather than preferred.

Pure and unit-testable with no browser: decode, field filter, batcher, buffer
ordering, backoff, envelope builder, unknown-verb classifier, version check.
That is the same seam that made 005's reconciler testable, applied again.

**The CORS preflight must be a contract test.** A JSON POST from
`https://fantasy.espn.com` triggers an OPTIONS preflight; a test that asserts
only the POST leaves the whole relay failing on draft day for a reason no test
covers.

**FR-022's version has two sources that can diverge**: the `@version` metadata
banner (which esbuild will not touch) and the inlined build constant. Derive
both from one value and assert equality at build time, or the tap reports a
version it is not.

---

## 7a. US1 GATE RESULT (2026-08-04) — **PASSED**

Captured from a real 12-round, 6-team snake draft in the test league: **70
picks over 7.9 minutes**, one mid-draft reconnect, 617 frames. Fixture:
`tests/fixtures/tap/capture-2026.jsonl` (sanitized; raw capture never
committed, per FR-019a).

### Transport — confirmed, with the fallback still unobserved

The draft channel is **`wss://fantasydraft.espn.com/game-1/league-<id>/JOIN?…`**
— WebSocket, plain-text verbs, trailing `\n` on every frame (§0's normalisation
finding confirmed). Verb census over 585 frames: `CLOCK` 249, `PONG` 86,
`SELECTED` 70, `SELECTING` 70, `AUTOSUGGEST` 70, `AUTODRAFT` 8, `JOINED` 7,
`INIT`/`TOKEN`/`STATE` 2 each.

**`PONG` is the inbound keep-alive** — §2's CORRECTION-4 confirmed; `PING` never
appeared inbound.

**SSE was NOT exercised.** The forced reconnect re-established over WebSocket.
The fallback path remains unobserved, so §0's ~7 s selector arithmetic stands as
bundle-derived but untested on the wire. Wrapping both transports remains
correct; the SSE branch ships unverified and must be treated as such.

**§4's second-socket warning is confirmed on live data.** ESPN opened four
`wss://espn.connections.edge.bamgrid.com/…` sockets on the same page carrying
JSON envelopes (`{"data":{"eventId":…}}`, DSS transport events). Unscoped
wrapping would relay that traffic and feed ESPN's own JSON to the draft
classifier, firing FR-017a's unrecognised counter continuously. **URL scoping is
mandatory on evidence, not inference.** The fixture deliberately retains these
frames as negative cases for the scoping test.

### The incremental stream is lossy; the ledger is what recovers it

**70 of 72 picks arrived as `SELECTED` frames** — rounds 1 and 5 are each one
short, lost across the page reload. The re-sent `INIT` discriminates perfectly:

- **27 of 27** picks made *before* the reconnect are present in it
- **0 of 43** made *after* it are

So `INIT` is exactly "state at connect time". A tap built on the incremental
stream alone silently loses ~3% of picks across one reload. This validates
FR-005/FR-012 and 005's ledger-as-truth recovery model **on measured data**
rather than on argument.

The ledger is a **fixed-size pre-allocated array**, not an append log: 7,464
bytes empty vs 7,472 bytes with 27 picks filled — 8 bytes of counter change.
Same shape as `mDraftDetail`'s skeleton.

### Ledger contents — §2's privacy finding confirmed empirically

Decoded both `INIT` blobs: **zero ASCII runs ≥ 6 chars, zero GUID-shaped
sequences, 64% null bytes**. `readUTF` really is never called. The ledger
carries no names and no SWIDs, so its blob is committable as-is.

### Environment — all three unknowns favourable

| Question | Result |
|---|---|
| **§5 `GM_xhr` vs CSP** | **RESOLVED — not blocked.** The probe returned **HTTP 401**, i.e. it *reached* `draft.neelamjai.com` (401 because `/api/tap/health` does not exist yet and fell through to the `/api/*` auth middleware). A CSP block would have produced a network error, not a status. The plan's one unverified load-bearing claim now holds. |
| **§4 SPA navigation** | **RESOLVED — real document load.** `navigationType: "navigate"`, `readyState: "loading"`, and the wrapper was installed before the page's client. `document-start` fires; the userscript delivery form survives. (A `replaceState` fires post-load — Next.js normalising the URL, not a route transition.) |
| **§4/§6 frames & origins** | **RESOLVED — top frame.** `isTopFrame: true`, `pageWorld: true`, `wrapperInstalled: true` on Chrome 150. `@noframes` is safe and the CORS allowlist is a single origin. |

**Chrome DevTools throttling does NOT force the SSE fallback** (observed
2026-08-04): offline mode there gates new HTTP requests but leaves an
already-open WebSocket connected, so ESPN never reconnects and never falls back.
Disabling wifi at the OS level is what would exercise it. The SSE path therefore
remains unobserved by anyone.

**Still unobserved**: sleep/wake behaviour (§6) — the machine was not slept, so
whether the room re-emits the ledger on resume remains unknown. The "resumed,
no ledger, no messages → loud reload prompt" requirement stands unvalidated.

### The independent oracle earned its place immediately

`tests/fixtures/tap/oracle-2026.json` — 72 picks from ESPN's post-draft
`mDraftDetail` flush, derived independently of the tap (FR-019b). Joining it to
the capture produced one confirmation and one correction:

- **Field 1 is the team id: 70/70.** No ambiguity remains.
- **Field 3 is NOT the round.** The contract briefly said it was, on the
  strength of a plausible-looking distribution (exactly six of each value
  1–12). Against the oracle it matches `roundId` on 5/70, `lineupSlotId` on
  18/70 (almost all in round 1, where a team's first RB coincidentally lands in
  the RB slot), `roundPickNumber` 7/70 and `overallPickNumber` **0/70**. It is
  now recorded as **unresolved**, carried as an opaque integer, with nothing
  depending on it — spec US1 AS3's escape hatch, used as intended.

This is the whole argument for FR-019b in one result: a corpus validated only
against itself would have shipped the wrong field meaning into 005's reconciler.
The oracle also shows the tap's arrival order matches `overallPickNumber`
exactly, so ordering is sound even though the frame carries no ordinal.

**Two defects in our own tooling surfaced here**, both worth recording:

1. `capture-draft.ts` counted filled picks with `playerId > 0`, which **excludes
   D/ST** (negative ids) — it reported 66/72 for a complete draft. That is the
   "never filter on sign" rule this project wrote into its own contract after
   observing negative ids, violated in the tool that observed them. Fixed to
   compare against the `-1` skeleton sentinel.
2. Run with `--once`, the script printed the full "mDraftDetail did NOT update
   during the draft — STOP" verdict, which a single sample cannot possibly
   establish. A false alarm of exactly the kind FR-017 exists to prevent, in the
   diagnostic tooling rather than the product. The verdict is now suppressed
   unless the run is continuous and live.

### Live-draft run (2026-08-04, shipped tap v0.1.2)

A second real draft, this time relayed by the shipped tap rather than the
instrumentation script. 72 batches accepted, 0 rejected, retained in
`tap_batches` and exported to `tests/fixtures/tap/replay-full.jsonl`.

- **69 picks + 3 ledger snapshots (sizes 0, 24, 31) = 72 distinct players** —
  the complete draft.
- **3 picks arrived ONLY in the ledger** (never as `SELECTED`). The incremental
  stream is lossy on a second, independent draft — this is no longer a
  one-off observation, and it is why FR-005 makes the ledger non-discretionary.
- All 6 D/ST negative ids survived end to end.
- Sequence contiguous, single epoch, no identifiers or URLs on the wire.

**Two tooling lessons from the run, both recorded because they cost real time:**

1. `wrangler tail` is **not a reliable observer**. It misses the first seconds
   while attaching (it missed both early ledger relays) and drops the session
   long before an explicit timeout (it died at 9:19 while traffic continued to
   9:20). Relying on it once produced a confident "no ledger relayed" that was
   simply wrong. The retained `tap_batches` table is the authoritative record.
2. `wrangler tail --format json` emits **pretty-printed multi-line JSON**, not
   line-delimited. A line-based parser matches the bare `{`, fails to parse, and
   silently reports nothing — which is how an entire live draft went unobserved
   while the relay worked perfectly. `scripts/tail-tap.mjs` decodes the stream
   by brace depth.

**Still unobserved after two live drafts**: the SSE fallback (Chrome DevTools
throttling does not force it — see above) and sleep/wake ledger behaviour.

### Pick rate — a measured number for the batcher

Pick-to-pick gaps: **median 3.75 s, minimum 1.0 s**, 33 of 69 gaps under 3 s
under autodraft. Batching must not add meaningful delay at a 1 s pick rate, and
bursts that fast are exactly the multi-pick observations 005 FR-020a exists to
handle.

---

## 8. What US1 must settle

Everything below is deliberately **not** decided here. ESPN's parser names
`SELECTED`'s three fields teamId, playerId, slotId, and the ledger's
`DraftPickStorableTranscoder` v3 carries `pickNumber` at field 3 — strong
evidence, but variable names are the client's model of the server, not proof,
and four public projects disagree with it and each other.

The capture is designed so the check can **fail**:

1. **Field 1 meaning** — a non-identity `pickOrder` (005's Gate 0 league is
   `[2,5,4,3,6,1]`) distinguishes team id from pick number in round 1; the snake
   reversal confirms it by round 2. Capture **≥ 3 rounds**.
2. **Ledger ↔ incremental agreement** — force a mid-draft reconnect (> 4 s
   offline) and confirm the re-sent ledger and the incremental frames agree on
   pick identity. This **also exercises the SSE path**, which no public tap has
   ever observed.
3. **Independent oracle** — ESPN's post-draft `mDraftDetail` flush supplies a
   truth set derived independently of the capture (FR-019b).
4. **`GM_xhr` vs CSP** — one request, ten minutes (§5).
5. **SPA navigation** — does entering the draft room reload the document? (§4)
6. **Sleep behaviour** — does the room re-emit the ledger on wake? (§6)
7. **Frames/origins** — is the realtime channel created by a script in a
   cross-origin iframe or popup? This one output determines the `@match`
   pattern, whether `@noframes` is safe, and the Worker's CORS allowlist.

**One structural fact makes FR-017a non-negotiable**: ESPN's `readFields` switch
has **no `default:` branch** — ESPN itself silently drops verbs it does not
know. Our behaviour must deliberately differ.
