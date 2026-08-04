---

description: "Task list for 010-draft-tap"
---

# Tasks: Draft Tap

**Input**: Design documents from `/specs/010-draft-tap/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/ingest.md, quickstart.md — and the deployed 001 build (accounts,
league connections). 005 consumes this feature's ingest contract and is blocked
until it lands.

**Tests**: Included, per the project's established pattern. The pure modules'
unit tests and the offline replay are the acceptance evidence for SC-009 and
SC-010.

**Organization**: US1 (gate — establish the protocol), US2 (picks reach Draft
Genie), US3 (install and pairing), US4 (honest status), US5 (recorded corpus).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US5 per spec.md

---

## Phase 1: US1 — Establish what ESPN actually sends (Priority: P1) 🚦 GATE

**Goal**: Every field meaning the relay depends on is established from observed
data, and the six other unknowns in research §8 are settled — in **one** draft
session, because a second costs a draft reset and an evening.

**Independent Test**: A decoded capture spanning ≥ 3 rounds in which the
identifying field's value tracks the drafting team across the snake reversal —
the only place team id and pick number diverge.

**⚠️ Nothing in Phases 2+ starts until this phase completes.** Constitution
v1.1.0 (Development Workflow) requires it, SC-000 asserts it, and 005's Gate 0
is the precedent for what skipping it costs.

- [X] T001 [US1] Write the throwaway instrumentation userscript `tap/capture.user.js`: `@run-at document-start`, page world, wrapping `WebSocket`, `EventSource`, `XMLHttpRequest` **and** `fetch` (streaming body via `ReadableStream.tee()`) — all four, because the transport is what this phase establishes. Record every frame with its transport, arrival time and the constructor URL; expose a menu command to download the log. This script is discarded after the gate; it is not the shipped tap
- [X] T002 [US1] Run the capture against a real draft in the test league: **≥ 3 rounds**, human-paced, with a **forced mid-draft reconnect** (offline > 4 s) to exercise ESPN's SSE fallback — which no public implementation has ever observed. Save the raw log **outside the repo**; it is credentialed material (FR-019a)
- [X] T003 [US1] Record the transport findings in `specs/010-draft-tap/research.md` §8: which surface(s) actually carried draft frames, whether the reconnect reached SSE, and the frame normalisation difference (WS frames carry a trailing newline, SSE frames do not)
- [X] T004 [US1] Establish and record every field meaning in `specs/010-draft-tap/contracts/ingest.md`: use the test league's non-identity `pickOrder` (`[2,5,4,3,6,1]`) to separate team id from pick number in round 1, confirm via the snake reversal in round 2, and confirm the ledger's pick number agrees with the incremental frames after the forced reconnect. **Mark any field that cannot be resolved as unresolved — no requirement may depend on it** (spec US1 AS3)
- [X] T005 [P] [US1] Settle the CSP question: fire one `GM_xmlhttpRequest` from the real ESPN draft-room page to a test route and record the status in research §5. This is the plan's single unverified load-bearing claim, and it is ten minutes
- [X] T006 [P] [US1] Settle whether entering the draft room reloads the document or is a client-side (Next.js) navigation, and record it in research §4. If it is an SPA transition, `@run-at document-start` never fires and the delivery form needs rethinking — **this can invalidate the plan, so record it before writing the shell**
- [ ] T007 [P] [US1] **PARTIAL — frames/origins resolved, sleep still unobserved.** The capture settled the iframe question (`isTopFrame: true`, so `@noframes` is safe and the CORS allowlist is one origin). **Outstanding**: does the room re-emit the ledger after machine sleep? The machine was not slept during the capture, so the "resumed, no ledger, no messages → loud reload prompt" behaviour (research §6) ships unvalidated. Settle it during the US5 end-to-end draft (T047) rather than spending a draft reset on it alone. Also outstanding and in the same bucket: the **SSE fallback was never exercised** — the reconnect re-established over WebSocket, so that branch ships bundle-derived but untested
- [X] T008 [US1] Extend `scripts/sanitize-espn.ts` to cover tap frames, then produce the sanitized capture `tests/fixtures/tap/capture-<season>.jsonl` from T002's raw log — the raw log is never committed (FR-019a)
- [ ] T009 [US1] Capture the **independent oracle** `tests/fixtures/tap/oracle-<season>.json` from ESPN's post-draft `mDraftDetail` flush, derived separately from the tap so SC-010's replay check can actually fail (FR-019b)

**Checkpoint**: field meanings established from data, six unknowns settled, two sanitized fixtures committed, raw capture destroyed or stored outside the repo.

---

## Phase 2: Setup

- [ ] T010 Create `tap/meta.ts` as the single source of the tap's version and metadata block (`@name`, `@version`, `@match`, `@run-at document-start`, `@sandbox raw`, `@inject-into page`, `@connect draft.neelamjai.com`, `@grant unsafeWindow/GM_setValue/GM_getValue/GM_deleteValue/GM_addValueChangeListener/GM_xmlhttpRequest/GM_registerMenuCommand`) — **no `@require`**, which is documented to delay injection past document-start. `@match` uses T007's finding
- [ ] T011 Create `build/build-tap.mjs`: esbuild bundle of `tap/` → `web/public/draft-tap.user.js` with the metadata banner prepended, plus a **build-time assertion that the banner's `@version` equals the inlined build constant** — esbuild does not touch the banner, so the two can silently diverge and the tap would report a version it is not (FR-022). Add `build:tap` to `package.json`
- [ ] T012 [P] Add `web/public/_headers` setting no-cache on `draft-tap.user.js` so an update is picked up rather than served stale; both files land in `web/dist/` via Vite's `publicDir`, already the assets directory in `wrangler.jsonc`
- [ ] T013 [P] Extend `vitest.config.ts` with a second project (`environment: "node"`) covering `tap/**` and `tests/tap/**`, alongside the existing workers-pool project — browser-side code cannot run under the workers pool. Verify `npm test` runs both and the existing 146 tests still pass
- [ ] T014 [P] Create `migrations/0006_tap.sql`: `tap_pairings` per data-model.md (PK id, account_id FK→accounts CASCADE, token_hash UNIQUE, install_id, created_at, last_used_at, expires_at, revoked_at) + `idx_tap_pairings_account`; apply locally

---

## Phase 3: Foundational — the pure core

**Purpose**: Everything with logic in it, testable in Node with no browser and
no Worker. This is the seam that made 005's reconciler testable, applied again.

**⚠️ Blocks all user stories.**

- [ ] T015 [P] Unit tests in `tests/tap/decode.test.ts` against the T008 fixture: the ledger reader is bounds-checked, asserts the transcoder version, and rejects a truncated or over-long record rather than reading past the end
- [ ] T016 [P] Implement `tap/decode.ts` — **our own** bounds-checked, version-asserting reader. Do **not** port ESPN's: their `readDouble`/`readFloat` discard the bytes and return `Math.random()`, so a port inherits garbage silently for every non-integer field (research §2). Byte advance is deterministic, so offsets are safe (tests T015 failing first)
- [ ] T017 [P] Unit tests in `tests/tap/filter.test.ts`: the FR-006a allowlist passes numeric ids, pick positions and timing; drops names, member identifiers (numeric **and** brace-form), chat and free text; **negative player ids survive** (D/ST ids are legitimately negative); and `location.href` is never present — the draft-room URL carries the owner's SWID as a query parameter
- [ ] T018 [P] Implement `tap/filter.ts` operating on **decoded** content only, never the wire form (FR-006c) (tests T017 failing first)
- [ ] T019 [P] Unit tests in `tests/tap/classify.test.ts` (FR-017a): a known non-draft kind (chat, presence, `PONG` — note `PING` is client→server only and we never send it) is dropped silently; an **unrecognised** verb is counted and reported. ESPN's own parser has no `default:` branch, so our behaviour deliberately differs
- [ ] T020 [P] Implement `tap/classify.ts` (tests T019 failing first)
- [ ] T021 [P] Unit tests in `tests/tap/batch.test.ts`: monotonic `seq` per `(install, session)`; `session` fresh per **page load** — never derived from `sessionStorage`, which is cloned on tab duplication and would collide; timing epoch increments when the clock anchor moves > 2 s; backoff shape and `Retry-After` handling; batch size cap
- [ ] T022 [P] Implement `tap/batch.ts` (tests T021 failing first)
- [ ] T023 [P] Unit tests in `tests/tap/buffer.test.ts` over an injected storage port: entries hold **filtered** messages only; ordering preserved across flush; truncation happens **only** on a read acknowledgement carrying `accepted_through`, never on an unacknowledged send; behaviour when storage is full
- [ ] T024 [P] Implement `tap/buffer.ts` against a storage port interface, so it is testable without a script manager (tests T023 failing first)
- [ ] T025 Implement `tap/status.ts`: the state model from data-model.md, including the two states that exist to prevent silent failure — `INCOMPATIBLE` (message shape changed **or** page-world preflight failed) and `draft-finished` distinct from `watching`

**Checkpoint**: decode → filter → classify → batch → buffer all implemented and tested against a real capture, with no browser involved.

---

## Phase 4: User Story 2 - Picks reach Draft Genie as they happen (Priority: P2)

**Goal**: A pick made in ESPN reaches Draft Genie within seconds, with the page
completely unaffected.

**Independent Test**: Quickstart scenarios 1–4 — every pick relayed in order and
acknowledged within 3 s, ESPN's interface identical with the tap active, and
ESPN's second unrelated socket ignored.

### Tests for User Story 2

- [ ] T026 [P] [US2] Wrapper tests in `tests/tap/intercept.test.ts`: the construct trap forwards `newTarget` (without it `class C extends EventSource` loses its methods and the draft breaks); statics, `.prototype` identity, `instanceof` both ways and `Function.prototype.toString` survive; a throwing tap listener does not propagate; and the wrapper is **URL-scoped** so ESPN's second, unrelated WebSocket is untouched
- [ ] T027 [P] [US2] Contract tests in `tests/contract/tap-ingest.test.ts` per contracts/ingest.md: `POST /api/tap/batch` returns `accepted_through`; a fully duplicate batch still returns 202; 401/403/409/429 are distinguishable; **and the CORS `OPTIONS` preflight is asserted** — `src/` has no Access-Control handling today, so a test that checks only the POST leaves the relay failing on draft day
- [ ] T028 [P] [US2] Replay test in `tests/tap/replay.test.ts`: the T008 capture through decode → filter → batch produces the pick sequence in the T009 oracle, compared against the **independent** oracle rather than against itself

### Implementation for User Story 2

- [ ] T029 [US2] Implement `tap/intercept.ts`: `new Proxy(Native, { construct })` for **both** `WebSocket` and `EventSource` — ESPN is WebSocket-first with SSE fallback reached in ~7 s of bad network, so a WebSocket-only tap goes dark exactly when the network is worst. `Reflect.construct(target, args, newTarget)`, URL-scoped by hostname, everything in `try/catch` (a throw anywhere in the trap propagates to the page's `new`), observation attached via a saved `addEventListener` reference, decode deferred with `setTimeout(…, 0)` — **not** `queueMicrotask`, which still drains on ESPN's critical path (depends on T016, T018, T020)
- [ ] T030 [US2] Implement `src/api/tap.ts` with `POST /api/tap/batch`, `POST /api/tap/status`, `GET /api/tap/health`, plus CORS preflight handling. Keep hono's CORS behaviour of **omitting** rather than rejecting on an unlisted origin — that is what the `GM_xmlhttpRequest` path needs; do not "fix" it with a 403 guard
- [ ] T031 [US2] Mount the tap routes in `src/api/app.ts` **before** `app.use("/api/*", …)` at [app.ts:34](src/api/app.ts:34) — that middleware is a bare prefix match, so a tap POST reaching it first returns 401 regardless of how correct the token is (depends on T030)
- [ ] T032 [US2] Implement `src/db/tap.ts`: issue, verify (by token hash), bind `install_id` on first use, touch `last_used_at`, revoke, rotate. Verification scopes each message's league to a connection the account owns — the credential is per-user, the league is per-message, which is how 005 FR-007d's per-connection scoping is satisfied (depends on T014)
- [ ] T033 [US2] Implement `tap/main.ts`, the impure shell (~50 lines): install the wrapper at document-start, run the **page-world preflight**, wire the pure modules, and relay via `GM_xmlhttpRequest` with `anonymous: true`. **No function the page can reach may close over the pairing token** — under `@sandbox raw` the tap shares ESPN's JS realm (depends on T029, T024, T022)
- [ ] T034 [US2] Make the flush **event-driven** in `tap/main.ts` — next observed message, `online`, `visibilitychange`, `pageshow`, `resume` — with a timer only as a backstop. A chained `setTimeout` in a hidden tab is throttled to one per second and then **one per minute**, which alone would fail SC-005's 60-second recovery (depends on T033)

**Checkpoint**: picks flow from a real draft room into Draft Genie. This is the feature.

---

## Phase 5: User Story 3 - Install it once, without handling secrets (Priority: P3)

**Goal**: The owner installs and pairs before draft day, without touching an
ESPN credential, and can revoke later.

**Independent Test**: Quickstart scenarios 10 and 15 — clean-profile install
under 10 minutes verified without a live draft, and revocation stopping the
relay within one message.

### Tests for User Story 3

- [ ] T035 [P] [US3] Pairing tests in `tests/contract/tap-pairing.test.ts`: issue, verify, rotate without reinstalling, expire on schedule, revoke; a revoked or expired token is refused within one message; a token bound to one install is refused from another; and the blast radius is bounded — the token cannot read league data or reach ESPN
- [ ] T036 [P] [US3] Isolation test in `tests/contract/tap-isolation.test.ts`: a batch naming a league the account does not own returns 403 and is not applied to any session

### Implementation for User Story 3

- [ ] T037 [US3] Build the pairing UI in `web/src/pages/` — issue a token, show it once, copy it, revoke, rotate, and show the install steps including the script-manager prerequisite (depends on T032)
- [ ] T038 [US3] Write the install guide covering the **named supported configuration** (FR-023): Chrome ≥ 138, Tampermonkey with **"Allow user scripts" ON** — it defaults **OFF** on new installs and the script silently never runs without it — plus the manual force-update step, since managers check on their own schedule and expose no force-check API (FR-022)
- [ ] T039 [US3] Add the `GET /api/tap/health` verification path to the install flow so the owner confirms the tap reaches Draft Genie **without waiting for a draft** (SC-006), and surface the iPad/mobile limitation where it will be encountered without searching (FR-003a, SC-012)

**Checkpoint**: a fresh machine can be set up for draft day and verified cold.

---

## Phase 6: User Story 4 - You can tell at a glance whether it is working (Priority: P4)

**Goal**: Every failure mode is visible and named, in the tab where it can be
fixed.

**Independent Test**: Quickstart scenarios 7, 11, 12, 13 — break each condition
in turn and confirm a distinct, accurate, actionable status.

### Tests for User Story 4

- [ ] T040 [P] [US4] Status-model tests in `tests/tap/status.test.ts`: each failure mode maps to a distinct state; `draft-finished` is distinguishable from `watching` (SC-014 forbids idle and dead looking the same); an unrecognised message drives `INCOMPATIBLE` while a known non-draft kind does not
- [ ] T041 [P] [US4] Preflight test in `tests/tap/preflight.test.ts`: the page-world assertion fails when the wrapped global is not the page's. In an isolated world `window.WebSocket` is not ESPN's and the tap would observe nothing **while appearing healthy** — Tampermonkey documents that `@sandbox raw` can fall back to another sandbox under CSP, so this is a real, silent failure mode

### Implementation for User Story 4

- [ ] T042 [US4] Implement the page-world preflight in `tap/main.ts`: assert **membership of the page realm**, not merely that the global is non-native, and drive `INCOMPATIBLE` loudly on failure (depends on T033, T025)
- [ ] T043 [US4] Implement the status badge in `tap/main.ts`: unobtrusive, never overlaying or intercepting a draft control (FR-002), showing state, last-relayed time and the tap version — and **redacting `location.href`** anywhere it appears, since the draft-room URL carries the owner's SWID
- [ ] T044 [US4] Relay status transitions to `POST /api/tap/status` so 005's FR-007c "not receiving picks" detection has a positive signal as well as an absence (depends on T030, T025)
- [ ] T045 [US4] Implement draft-end detection in `tap/main.ts` (FR-024): stop relaying and say so; where the tap cannot tell whether a draft is running, report that uncertainty rather than going quiet

**Checkpoint**: the tap is never silently dead.

---

## Phase 7: User Story 5 - A recorded corpus that unblocks the roadmap (Priority: P5)

**Goal**: 005, 006 and 008 can be built and tested with no live draft.

**Independent Test**: Quickstart scenario 14 — the committed corpus replays
offline to the independent oracle's pick sequence.

- [ ] T046 [P] [US5] Build the `/tap/self-test` replay harness in `web/src/pages/` — a product deliverable, not just a test: load the committed corpus, run it through decode → filter, and show the resulting pick sequence, so a protocol regression is diagnosable without a draft
- [ ] T047 [US5] Capture the **full-draft** corpus with the shipped tap (not the T001 instrumentation script) and commit it as `tests/fixtures/tap/replay-full.jsonl`, sanitized and verified clean before commit (depends on T033)
- [ ] T048 [US5] Publish the finalised message contract in `specs/010-draft-tap/contracts/ingest.md` with **every field's meaning recorded against the capture it was derived from and zero fields marked "assumed"** — this is SC-000's evidence and what 005 builds against (depends on T004, T047)

---

## Phase 8: Polish & Cross-Cutting

- [ ] T049 [P] Passivity verification (FR-001, SC-003): review the shipped `web/public/draft-tap.user.js` for any write to an ESPN origin, then run a draft with all egress blocked except Draft Genie's ingest and confirm the draft proceeds unchanged with no additional ESPN request. Record the result in `specs/010-draft-tap/quickstart.md`
- [ ] T050 [P] Privacy sweep (SC-007): dump every transmission and the buffer contents from a full draft and assert numeric ids, pick positions and timing only — no name, no member identifier in either form, no chat, no `location.href`
- [ ] T051 [P] Traceability check (SC-015): confirm every FR in spec.md is validated by at least one success criterion or acceptance scenario, and record the result — the first pass of this spec asserted traceability it did not have
- [ ] T052 Full sweep: `npm test` (both projects), tsc, eslint, `npm run build:tap && npm run build` — all clean; then run every quickstart.md validation scenario
- [ ] T053 End-to-end validation (SC-001, SC-011): a real draft with the shipped tap, Draft Genie open on a second device, confirming 100% of picks relayed against ESPN's post-draft record — and, if a second league drafts, that both relay independently from one install
- [ ] T054 Record the draft-day operational notes for 009 in `specs/010-draft-tap/quickstart.md`: force a script-manager update check beforehand, keep the ESPN draft-room tab open because it *is* the tap, and iPad/mobile means no live monitoring

---

## Dependencies & Execution Order

### Phase Dependencies

- **US1 gate (Phase 1)**: no dependencies — **blocks everything**. T006 in particular can invalidate the plan's delivery form, so it must be answered before any shell code is written.
- **Setup (Phase 2)**: after the gate; `@match` (T010) depends on T007.
- **Foundational (Phase 3)**: after Setup — blocks all stories. Its tests run against the gate's fixtures.
- **US2 (Phase 4)**: after Foundational.
- **US3 (Phase 5)**: after US2's `src/db/tap.ts` (T032) exists.
- **US4 (Phase 6)**: after US2's shell (T033) exists — all its tasks edit `tap/main.ts`, so it is **not** file-disjoint from US2.
- **US5 (Phase 7)**: after US2 — needs the shipped tap to record with.
- **Polish (Phase 8)**: last.

### Parallel Opportunities

- **Phase 1**: T005, T006, T007 are independent observations from the same session.
- **Phase 2**: T012–T014 are three different files.
- **Phase 3**: five independent pure modules — T015/T016, T017/T018, T019/T020, T021/T022, T023/T024 all run in parallel, each test-first.
- **Phase 4**: T026–T028 in parallel; T030/T032 (Worker side) in parallel with T029 (browser side).
- **Phase 8**: T049–T051 in parallel.
- **Across stories**: US3's Worker-side work can proceed alongside US4's shell work; US4 and US2 cannot run concurrently — both rewrite `tap/main.ts`.

---

## Parallel Example: Phase 3 (Foundational)

```bash
# Five independent pure modules, each test-first, no browser:
Task: "Unit tests for the ledger decoder in tests/tap/decode.test.ts"
Task: "Unit tests for the FR-006a allowlist in tests/tap/filter.test.ts"
Task: "Unit tests for the verb classifier in tests/tap/classify.test.ts"
Task: "Unit tests for batching and timing epochs in tests/tap/batch.test.ts"
Task: "Unit tests for the buffer in tests/tap/buffer.test.ts"
```

---

## Implementation Strategy

### Gate first, and mean it

Run Phase 1 alone, in one draft session. Seven answers, one draft reset. Do not
write the shell before T006 — if the draft room is entered by client-side
navigation, `document-start` never fires and the delivery form is wrong.

### MVP (Gate → Phase 4)

Gate → Setup → Foundational → US2. That is picks flowing from a real draft into
Draft Genie, which is the entire point and what unblocks 005.

### Incremental delivery

1. Gate → protocol established, fixtures committed.
2. + Setup + Foundational → the whole decode/filter/buffer core, tested in Node.
3. + US2 → **MVP**: picks reach Draft Genie.
4. + US3 → installable and revocable by someone other than the author.
5. + US4 → never silently dead.
6. + US5 → 005, 006 and 008 unblocked without a live draft.

### Notes

- `[P]` = different files, no dependencies.
- The pure modules must not import anything browser- or Worker-specific. If a
  task tempts you to, the logic is in the wrong file.
- Commit after each task or logical group.
