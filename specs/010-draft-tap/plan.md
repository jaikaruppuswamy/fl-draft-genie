# Implementation Plan: Draft Tap

**Branch**: `010-draft-tap` | **Date**: 2026-08-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/010-draft-tap/spec.md`

## Summary

A single-file userscript, injected at document-start into the user's own ESPN
draft-room tab, wraps `WebSocket` **and** `EventSource` with a URL-scoped
construct-trap `Proxy`, observes the frames ESPN's page is already receiving,
decodes them with our own reader, strips everything but numeric ids and an
observation time, buffers durably, and relays batches to a new `/api/tap/*`
ingest route on the existing Worker. It opens nothing to ESPN and sends nothing
to ESPN.

**Gate first**: US1's capture runs before the relay is built. Field meanings are
established from data spanning ≥ 3 rounds, and six other unknowns
(§8 of research) are settled in the same session — because a second real draft
costs a draft reset and an evening.

## Technical Context

**Two runtimes, one repo**: browser userscript (new) + the existing Cloudflare
Worker. No new production dependencies; esbuild (already transitively present
via Vite) bundles the tap.

**Transport**: wrap both `WebSocket` and `EventSource`. ESPN is WebSocket-first
with SSE fallback reached in ~7 s on bad network — a WebSocket-only tap goes
dark exactly when the network is worst (research §0).

**Wrapper**: `new Proxy(Native, { construct })` calling
`Reflect.construct(target, args, newTarget)` — **`newTarget` must be forwarded**
or subclassing breaks and the user's draft breaks with it. URL-scoped to the
draft host, because ESPN's commons bundle opens a second unrelated WebSocket on
the same page. Everything in `try/catch`; decode deferred with `setTimeout(…,0)`,
not `queueMicrotask`.

**Ingest**: `GM_xmlhttpRequest` with `@connect draft.neelamjai.com` and
`anonymous: true`; new `/api/tap/*` routes mounted **before** the `/api/*` auth
middleware at [app.ts:34](src/api/app.ts:34), with CORS preflight handling that
does not exist in `src/` today.

**Storage**: script-manager storage for buffer and credential — never
`espn.com` localStorage, which is ESPN's own bucket.

**Performance**: SC-002 requires ingest acknowledgement within 3 s of
observation, deliberately inside 005's 5 s end-to-end budget.

**Testing**: second Vitest project (`environment: "node"`) for the tap's pure
modules alongside the existing workers pool; verified to run the full existing
suite (33 files / 146 tests) plus the new project in one `vitest run`.

**Named supported configuration (FR-023)**: Chrome ≥ 138, Tampermonkey with
"Allow user scripts" **ON** (defaults OFF), no `@require`.

**Known unknowns carried into US1** (research §8): field meanings; ledger ↔
incremental identity agreement; `GM_xhr` vs page CSP; whether the draft room is
entered by SPA navigation (which would mean document-start never fires); whether
the room re-emits the ledger on wake from sleep; and whether the channel is
created inside a cross-origin iframe (which determines `@match`, `@noframes` and
the CORS allowlist).

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I Spec-first | PASS | Spec + 3 clarifications + adversarial review precede |
| II Any-league | PASS | League identified per message from the page context; nothing hardcoded |
| III League currency | N/A | This feature computes no points |
| IV Rules are code | PASS | No settings surface; the allowlist and classifier are code |
| V Draft day | PASS | Buffer + ledger recovery ranked; event-driven flush (a timer alone is throttled to 1/min in a hidden tab); loud on every failure mode |
| VI Recommend, never act | **PASS — the central check** | Wrapper is construct-trap only; `send`/`onmessage`/`close` untouched; no ESPN connection opened; no send path exists. Verified in Chrome that the page's handler fires first and is never delayed. Identity caveat recorded honestly: `Proxy !== Native` is observable in principle, though nothing ESPN does observes it |
| VII Explainable | N/A | No recommendations here |
| VIII Simplicity | PASS | One artifact, one file, no new production dependency |

**Security & Privacy** (constitution, extended 2026-08-03): three separate
identity leaks are closed by design — the ledger carries no strings at all
(`readUTF` is never called), names/SWIDs live only in the text protocol which is
discarded wholesale, and **the draft-room URL itself carries the owner's SWID**,
so `location.href` is never relayed and is redacted in diagnostics. Filtering
happens **before** buffering, so nothing unstripped is written to disk.

**Post-Phase-1 re-check**: PASS. No new services, no user-facing settings. The
one deliberate widening — a browser artifact — is the constitution amendment
already ratified in v1.1.0, and this plan stays inside it: exactly one
companion, strictly passive, web app fully usable without it.

## Project Structure

### Documentation (this feature)

```text
specs/010-draft-tap/
├── plan.md, research.md, data-model.md, quickstart.md
├── contracts/ingest.md      # tap → Worker contract (005 consumes)
├── checklists/requirements.md
└── tasks.md (next phase)
```

### Source Code (additions)

```text
tap/
├── meta.ts             # metadata block (single source of @version)
├── main.ts             # impure shell: wrap, preflight, wire the seam (~50 lines)
├── intercept.ts        # PURE: proxy factory, URL scoping, newTarget forwarding
├── decode.ts           # PURE: our own bounds-checked ledger reader (never ESPN's)
├── filter.ts           # PURE: FR-006a allowlist over DECODED content
├── classify.ts         # PURE: draft / known-non-draft / unrecognised (FR-017a)
├── batch.ts            # PURE: batching, seq, timing epochs, backoff
├── buffer.ts           # PURE over an injected storage port
└── status.ts           # PURE status model; the DOM badge lives in main.ts
build/build-tap.mjs     # esbuild bundle + banner; asserts @version === __TAP_VERSION__
web/public/draft-tap.user.js   # built artifact, served by existing assets config
web/public/_headers            # no-cache for the .user.js
src/api/tap.ts          # ingest routes + CORS preflight
src/api/app.ts          # (extend) mount /api/tap/* BEFORE the /api/* auth middleware
src/db/tap.ts           # pairing credentials: issue, verify, revoke, rotate
migrations/0006_tap.sql # tap_pairings
web/src/pages/…         # pairing UI (issue / revoke / show install steps)
vitest.config.ts        # (extend) second project, environment: node, for tap/**
tests/tap/*.test.ts     # pure-module unit tests
tests/contract/tap-ingest.test.ts   # ingest + CORS PREFLIGHT (untested today)
tests/fixtures/tap/     # US1 capture (sanitized) + independent oracle
```

**Structure Decision**: `tap/` is top-level rather than under `src/` because it
targets a different runtime and must never be pulled into the Worker bundle. The
pure/impure split is the same seam that made 005's reconciler testable: the
impure shell is small enough to review by eye, and everything with logic in it
runs in Node with no browser.

## Implementation Phases

**Gate (US1) — capture and decode before anything else.** One draft on the test
league, instrumented across WebSocket/EventSource/XHR/fetch, capturing ≥ 3
rounds with a forced mid-draft reconnect. Settles field meanings and the six
other unknowns in research §8. Raw capture is credentialed material (FR-019a):
sanitized before it leaves the machine, never committed raw.

**Phase A — pure core.** decode, filter, classify, batch, buffer + unit tests
against the sanitized capture. No browser, no Worker.

**Phase B — ingest.** `/api/tap/*`, pairing credentials, CORS preflight, contract
tests. Testable with recorded batches; no browser needed.

**Phase C — the shell.** Wrapper, preflight assertion of page-world membership,
status badge, build pipeline, install docs.

**Phase D — end-to-end.** Real draft with the tap live, `/tap/self-test` replay,
passivity verification, and the committed corpus that unblocks 005.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A browser artifact outside the web app | ESPN exposes live picks nowhere else — established empirically by 005's Gate 0. Ratified in constitution v1.1.0 | Polling any ESPN read view returns nothing mid-draft (207 samples, 0 picks). A server-side draft-room connection requires `JOIN`, which registers a participant — Constitution VI forbids it |
| Second Vitest project | Browser-side code cannot run under `@cloudflare/vitest-pool-workers` | One pool means either no tests for the tap's logic, or moving the Worker suite off the pool that gives it D1 and bindings |
| Our own ledger decoder rather than porting ESPN's | ESPN's `readDouble`/`readFloat` **discard the bytes and return random numbers**; a port inherits that silently | Using ESPN's reader as ground truth is wrong for every non-integer field |
