---

description: "Task list for 005-draft-monitor"
---

# Tasks: Draft Monitor

**Input**: Design documents from `/specs/005-draft-monitor/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/api.md, quickstart.md — and the deployed 001/002 build (connections,
credentials, player board).

**Tests**: Included, per the project's established pattern. The pure reducer's
unit tests and the full-draft replay ARE the acceptance evidence for SC-003,
SC-010 and FR-021 — they are not optional here.

**Organization**: US1 (follow a live draft), US2 (survive reloads and crashes),
US3 (session arms itself), US4 (event contract for 006/007/008).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 per spec.md

---

## Phase 1: Gate 0 — Validate the premise (BLOCKING, stop-the-line)

**Purpose**: Establish that ESPN's `mDraftDetail` reflects picks *during* a
draft. It is not established (research §0), and if it is false this feature's
design does not work. Nothing else starts until this passes.

- [ ] T001 Write a read-only capture script `scripts/capture-draft.ts` that pulls `mDraftDetail`, `mSettings`, `mTeam` and `mRoster` for a given connection through the existing `src/espn/client.ts` and writes timestamped JSON to `tests/fixtures/espn/draft/`, redacting nothing but never printing cookies
- [ ] T002 Run the capture against a real ESPN draft (a mock draft in a connected league is sufficient) at four moments — order-published+skeleton, room-open (`inProgress:true`, zero filled picks), mid-draft (at least three captures minutes apart), and complete — saving to `tests/fixtures/espn/draft/{order,open,mid-1,mid-2,mid-3,complete}.json`
- [ ] T003 Record the verdict in `specs/005-draft-monitor/research.md` §0 under a new "Gate 0 result" heading: does `picks[]` with `playerId > 0` grow between the mid-draft captures? **If NO — STOP and run `/speckit-clarify`**; SC-001 is unachievable by polling and the alternative transport raises a Constitution VI question this plan does not answer
- [ ] T004 With the capture in hand, resolve the three UNVERIFIED items in research §4 and update it in place: (a) is skeleton `teamId` pre-filled on empty snake slots, (b) do keepers occupy real `overallPickNumber` slots in `picks[]` or appear only in `roster.entries[]`, (c) what `autoDraftTypeId` values actually appear
- [ ] T005 Assemble the full-draft replay corpus `tests/fixtures/espn/draft/replay-full.json` — the complete ordered observation sequence from one real draft, which is SC-010's offline evidence and FR-021's test input

**Checkpoint**: The premise holds and every downstream test has real data to run against.

---

## Phase 2: Setup

- [ ] T006 Add the Durable Object to `wrangler.jsonc`: `durable_objects.bindings` `{ name: "DRAFT_SESSION", class_name: "DraftSession" }` plus `migrations: [{ tag: "v1", new_sqlite_classes: ["DraftSession"] }]` — **use the legacy `migrations` array, not the `exports` field** (research §1: `exports` silently provisions a KV-backed DO under the installed test pool while production is SQLite-backed)
- [ ] T007 [P] Create `migrations/0005_draft.sql`: `draft_sessions` (PK connection_id, FK→league_connections CASCADE, FK account_id→accounts CASCADE, status CHECK, scheduled_at, last_observed_at, pick_count, completed_at, archived_at) + `idx_draft_sessions_open`, and the archive tables `draft_picks` / `draft_keepers` keyed on `(account_id, connection_id, season, …)` with **no FK to league_connections** (data-model.md); apply locally
- [ ] T008 [P] Extend `src/env.ts` with `DRAFT_SESSION: DurableObjectNamespace<DraftSession>` using a **type-only** import to avoid a runtime cycle, and re-export the `DraftSession` class from `src/index.ts` (which currently exports only `default`)
- [ ] T009 [P] Create `vitest.draft.config.ts` at repo root (**not** in a subdirectory — the pool resolves `wrangler.configPath` relative to the config file's own directory) covering `tests/draft/**` with `isolatedStorage: false`, and wire both projects into `npm test` in `package.json`
- [ ] T010 [P] Bump `@cloudflare/vitest-pool-workers` past 0.8.71 so `evictDurableObject` exists, and confirm the existing suite still passes on the new version before any DO code depends on it

---

## Phase 3: Foundational (Blocking Prerequisites)

**Purpose**: The pure core. `reconcile.ts`, `cadence.ts` and `snake.ts` import
**nothing from the platform** — that rule is what makes FR-021 true by
construction and keeps the DO a thin shell.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [ ] T011 [P] Extend `src/espn/types.ts` with the real `draftDetail.picks[]` shape captured in Gate 0 (playerId, teamId, roundId, roundPickNumber, overallPickNumber, keeper, autoDraftTypeId, bidAmount, nominatingTeamId) and `mRoster`'s `teams[].roster.entries[]`
- [ ] T012 [P] Extend `src/espn/client.ts` with the `mRoster` view (new to this repo) — read-only, no new write methods
- [ ] T013 Implement `parseDraftObservation()` in `src/espn/parsers.ts`: filter to `playerId > 0` (D/ST ids are legitimately **negative**, so never `!== -1`), map picks to the internal shape, union keeper picks with `roster.entries` by `playerId`, and route `bidAmount`/`nominatingTeamId` into the format-specific `detail` slot rather than the shared shape (depends on T011, T012)
- [ ] T014 [P] Unit tests for the cadence function in `tests/unit/cadence.test.ts`: 60 s armed, 30 s unattended, 10 s attended, 3 s within 3 picks; back-off ladder on consecutive errors; `league_not_found` routes to terminal rather than climbing the ladder; re-anchor when more than one interval behind (no catch-up burst)
- [ ] T015 [P] Implement pure `nextPollDelayMs()` in `src/draft/cadence.ts` over `{ status, clientsAttached, picksUntilTurn, consecutiveErrors, dueAt, now }` — constants only, no config surface (Constitution IV) (tests T014 failing first)
- [ ] T016 [P] Unit tests for snake projection in `tests/unit/snake.test.ts`: `teamAt(n)` for both directions of the serpentine, observed fact preferred below the frontier, skeleton `teamId` preferred over projection, `orderTrust` degrading to `unknown` when the order is absent, remaining-schedule generation, and traded-pick divergence yielding `projected` rather than `observed`
- [ ] T017 [P] Implement pure `src/draft/snake.ts`: `teamAt()`, `picksUntilTurn()`, `remainingSchedule()`, `orderTrust` tri-state (tests T016 failing first)
- [ ] T018 Unit tests for the reducer in `tests/unit/reconcile.test.ts` — the heart of the feature: pure append (`c == m`), no-op idempotency (`c == m == n` ⇒ **zero** events, no persist), correction (`c < m` ⇒ list surgery + one `draft_revised`, marks cleared above `c`, no retraction), batched observation revealing five picks (every implied event in order, `on_deck` never skipped, shared `observed_at`), turn-boundary collapse (`picks_until` legitimately 0 at snake round turns), and the stale-observation guard (`obsSeq > lastObsSeq` prevents a phantom undo)
- [ ] T019 Implement the pure reducer `src/draft/reconcile.ts`: `(state, observation) → (state, events[])` via longest-common-prefix + one-step-at-a-time pointer replay guarded by the persisted `turn_marks` set; assign `(epoch, seq)`; compute `stateFingerprint` **excluding** epoch/seq/revision/observed_at/turn_marks/event log per data-model.md (depends on T013, T017; tests T018 failing first)
- [ ] T020 [P] Implement `src/db/draft.ts`: `draft_sessions` header upsert, the cron work-list query (`archived_at IS NULL AND status NOT IN ('aborted','unsupported')`), and per-account-scoped reads for the API layer

**Checkpoint**: The entire draft brain is implemented and tested with no Durable Object in sight.

---

## Phase 4: User Story 1 - Follow a live draft pick by pick (Priority: P1) 🎯 MVP

**Goal**: Every pick, roster, on-the-clock team and picks-until-my-turn visible
and updating without user action.

**Independent Test**: Quickstart scenarios 1, 2 and 13 — replay the captured
mid-draft sequence and confirm state matches ESPN throughout, keepers count
once, and an auction league reports unsupported.

### Tests for User Story 1

- [ ] T021 [P] [US1] Contract tests in `tests/draft/api-draft.test.ts` for `GET /api/leagues/:id/draft`, `/snapshot` and `POST /open` per contracts/api.md, including `status: "unsupported"` for an auction league (opens no session, arms no alarm) and 404 for a connection owned by another account
- [ ] T022 [P] [US1] Integration test in `tests/draft/live-tracking.test.ts`: drive a session through the captured mid-draft observations and assert picks, rosters, on-the-clock team, picks-until-my-turn and the available set at each step
- [ ] T023 [P] [US1] Keeper test in `tests/draft/keepers.test.ts`: pre-draft rostered players are unavailable and attributed from pick one, and are counted **once** even when they appear in both `picks[]` and `roster.entries[]`

### Implementation for User Story 1

- [ ] T024 [US1] Create the `DraftSession` DO in `src/draft/session.ts`: SQLite-backed, live state as one JSON blob under key `"session"` in the synchronous `ctx.storage.kv` API, with the RPC surface `ensureRunning()` / `snapshot()` / `shutdown()`
- [ ] T025 [US1] Implement the alarm loop in `src/draft/session.ts` with all four research §2 corrections: **arm the safety alarm as the first statement of `alarm()`** (the pending alarm is consumed on entry, so a mid-handler shutdown otherwise kills polling until the cron), `alarm()` never rethrows (an uncaught throw triggers at-least-once retry and re-polls ESPN), re-anchor `dueAt` when behind, and drive the interval from `nextPollDelayMs()` (depends on T015, T024)
- [ ] T026 [US1] Implement the poll path in `src/draft/session.ts`: fetch `?view=mDraftDetail` **alone** while live, decrypt credentials **per request** from D1 and never hold them in DO storage or instance state (FR-024a), feed `parseDraftObservation` → `reconcile`, and gate the persist on `events.length > 0 || orderChanged || statusChanged` (no-op observations must not commit) (depends on T019, T025)
- [ ] T027 [US1] Implement the WebSocket upgrade in `src/draft/session.ts` using `ctx.acceptWebSocket()` — the hibernation API is **mandatory**, because `ctx.getWebSockets()` returns 0 for `server.accept()` sockets and FR-007a's attendance-driven cadence depends on it — send the `snapshot` frame inside the handler *before* returning the 101, and define `webSocketClose()`/`webSocketError()` (or every disconnect throws) **without** calling `ws.close(code)` in the body (a browser close surfaces 1005, which throws on the pinned runtime)
- [ ] T028 [US1] Implement broadcast-after-commit in `src/draft/session.ts`: fan out to `ctx.getWebSockets()` only after the state transaction commits, and age out zombie sockets with `setWebSocketAutoResponse()` + `getWebSocketAutoResponseTimestamp()` so a vanished client cannot hold the 10 s tier (depends on T027)
- [ ] T029 [US1] Create `src/api/draft.ts` with the status, snapshot, open and WebSocket-upgrade routes; the upgrade authenticates at the edge and calls the DO with a **synthesized** request carrying no cookie, and mount it in `src/api/app.ts` under `/api/leagues/:id/draft` (the `/api/` prefix is what makes `run_worker_first` route it to the Worker instead of the SPA)
- [ ] T030 [P] [US1] Create `web/src/lib/draftSocket.ts`: connect, hold the `(epoch, seq)` cursor, apply frames, and expose state to React
- [ ] T031 [US1] Create the deliberately plain diagnostic page `web/src/pages/DraftDiagnostics.tsx` (FR-025) showing session status, live pick feed, on-the-clock, each team's roster, picks-until-your-turn and staleness age — **not** styled to the Organic design system and not reusing 007's draft-room design, plus its route in `web/src/main.tsx` (depends on T030)

**Checkpoint**: A live draft can be watched end to end. This is the MVP.

---

## Phase 5: User Story 2 - Survive reloads, disconnects, and crashes (Priority: P2)

**Goal**: Reload, network drop, or a destroyed session all return complete,
correct state.

**Independent Test**: Quickstart scenarios 3, 4, 7 and 8 — reload restores in
under 3 s, a destroyed session rebuilds to a matching fingerprint, a 60 s ESPN
outage loses nothing, and a correction reconciles without duplicates.

### Tests for User Story 2

- [ ] T032 [P] [US2] Rebuild test in `tests/draft/rebuild.test.ts`: destroy the DO mid-draft, rebuild from ESPN alone, assert `stateFingerprint` matches the pre-crash value and that the new `epoch` differs (clients take a fresh snapshot by design)
- [ ] T033 [P] [US2] Reconnect test in `tests/draft/reconnect.test.ts`: `?since=N` with an unchanged epoch yields snapshot + only events `> N`; a mismatched epoch forces a full snapshot and cursor reset; duplicate frames are discarded rather than triggering a resync storm; mid-draft join yields 100% of prior picks
- [ ] T034 [P] [US2] Outage test in `tests/draft/degraded.test.ts`: with ESPN unreachable for 60 s, state keeps serving with `staleness.degraded` and a rising age, back-off climbs, and every pick made during the outage appears within one cycle of recovery; `espn_rejected` surfaces as a credential problem distinct from an outage
- [ ] T035 [P] [US2] Correction test in `tests/draft/corrections.test.ts`: an observation with a pick removed or reordered reconciles to ESPN's truth, emits exactly one `draft_revised`, retracts nothing, and produces no duplicate or phantom picks

### Implementation for User Story 2

- [ ] T036 [US2] Implement rebuild-from-ESPN in `src/draft/session.ts`: fetch `mSettings` + `mTeam` + `mRoster` + `mDraftDetail`, rebuild state with no reliance on stored state, regenerate `epoch`, and reset the cursor (depends on T026)
- [ ] T037 [US2] Implement cursor resume in `src/draft/session.ts` and `web/src/lib/draftSocket.ts`: retained event window, `?since=` handling, epoch-mismatch full resync, and client-side discard of `seq <= cursor` with resync only on a true forward gap (depends on T027, T030)
- [ ] T038 [US2] Implement degraded handling in `src/draft/session.ts`: catch ESPN errors inside `alarm()`, emit a `status` frame rather than throwing, climb the back-off ladder, keep serving last-known state, and distinguish `espn_rejected` (credentials, FR-023) from `espn_unreachable` in both the frame and the status payload (depends on T025)
- [ ] T039 [US2] Add the single in-flight-poll gate and `obsSeq` monotonic guard in `src/draft/session.ts` so a slow ESPN response returning after a newer one cannot be read as a commissioner undo (research §7 — load-bearing correctness, not hygiene)

**Checkpoint**: The monitor is trustworthy when things go wrong, which is the point of Constitution V.

---

## Phase 6: User Story 3 - The session arms itself before the draft (Priority: P3)

**Goal**: No draft-day ritual — sessions arm, capture the order, and go live on
their own.

**Independent Test**: Quickstart scenarios 5 and 13 — the cron arms a scheduled
draft, the order appears when published, the session flips to live, an
unsupported format never opens, and a session destroyed with no client attached
is restored by the cron alone.

### Tests for User Story 3

- [ ] T040 [P] [US3] Cron test in `tests/draft/cron-arm.test.ts` (fake clocks): entering the pre-draft window arms a session without any client; the order and the owner's slot appear within one cycle of publication; `inProgress:true` transitions the session to live with no user action
- [ ] T041 [P] [US3] Unattended-recovery test in `tests/draft/cron-restore.test.ts`: destroy a live session with **no** client connected and assert the cron restores it — and, critically, that a *degraded* session is **not** restored (the predicate is `getAlarm()` is null, never a `last_observed_at` threshold, which would rebuild spuriously during an outage)

### Implementation for User Story 3

- [ ] T042 [US3] Implement `ensureRunning()` in `src/draft/session.ts`: idempotent, re-arms only when `getAlarm()` is null — **never** using `getAlarm() === null` as a health test from outside (it returns null while the handler runs, so the cron would clobber healthy schedules) — and wrap the load-mutate-store section in `ctx.blockConcurrencyWhile`
- [ ] T043 [US3] Extend `src/sync/predraft.ts` with the draft sweep, running **after** the league re-sync so a just-published draft time arms on the same tick: arm supported drafts inside the pre-draft window, then call `ensureRunning()` across the D1 work-list (depends on T020, T042)
- [ ] T044 [US3] Implement the armed absolute deadline in `src/draft/session.ts`: a postponed or cancelled draft transitions to `aborted` rather than heartbeating forever — without it a single stuck session bills ~11,000 GB-s/day (research §2)
- [ ] T045 [US3] Implement the unsupported-format path in `src/draft/session.ts` and `src/api/draft.ts`: auction and offline drafts report `status: "unsupported"`, open no session and arm no alarm, leaving the league fully usable elsewhere (FR-006)

**Checkpoint**: Draft day requires no ritual, and nothing polls forever.

---

## Phase 7: User Story 4 - Events the engine and UI can build on (Priority: P4)

**Goal**: The ordered, exactly-once event stream that 006, 007 and 008 are
built against.

**Independent Test**: Quickstart scenarios 9 and 10 — the full captured draft
replayed through the pure reducer produces exactly the expected sequence.

### Tests for User Story 4

- [ ] T046 [P] [US4] Full-draft replay test in `tests/unit/replay.test.ts` (SC-010, DO-free): the entire `replay-full.json` corpus through `reconcile()` yields one `pick_made` per pick in order, paired `on_deck`/`on_the_clock` per owner turn with none skipped or duplicated, and exactly one terminal `draft_complete`
- [ ] T047 [P] [US4] Format-neutrality test in `tests/unit/format-neutral.test.ts` (SC-009a): no shared state field or event payload requires knowing the format is snake; a consumer fed an unfamiliar event kind keeps working; ordinal sequence fields are populated where defined and empty otherwise
- [ ] T048 [P] [US4] Event-payload contract test in `tests/draft/events.test.ts`: every event carries `(epoch, seq, observed_at)`; events from one observation share `observed_at`; `on_deck.payload.picks_until` reports the real value including **0** at snake round boundaries; `on_the_clock` carries the remaining schedule

### Implementation for User Story 4

- [ ] T049 [US4] Finalize event payloads in `src/draft/reconcile.ts` to match contracts/api.md exactly — `pick_made`, `on_deck` (with real `picks_until`), `on_the_clock` (with `remaining_schedule`), `draft_complete`, `draft_revised` (depends on T019)
- [ ] T050 [US4] Add the `format` discriminator and the per-entry format-specific `detail` slot throughout `src/draft/reconcile.ts` and `src/db/draft.ts` per FR-006a, with a comment recording that no auction behavior is implemented — only the shape that lets it be added without reworking consumers
- [ ] T051 [P] [US4] Document the two downstream contract notes in `specs/005-draft-monitor/contracts/api.md` if Gate 0 changed anything: `picks_until` may be 0 (006 must pre-compute its second pick off `on_the_clock(T)`), and unknown event kinds must be tolerated

**Checkpoint**: 006 and 008 have a contract they can build against without a live draft.

---

## Phase 8: Retention & Hardening

**Purpose**: FR-013's forever-archive and the security/lifecycle edges. These
serve no single story but the feature is not done without them.

- [ ] T052 [P] Archive test in `tests/draft/archive.test.ts`: on completion the D1 archive holds every pick, the keepers, the order, the teams and the owner's team; it survives a later league re-sync **and** disconnecting the league; `observed_at` is first-seen-wins after a rebuild
- [ ] T053 Implement `src/draft/archive.ts`: on completion write `draft_picks` + `draft_keepers` in one `db.batch()` chunked at **10 rows per statement** (D1's 100-bound-parameter cap), **copy** `teams_json`, `order_json` and `my_team_id` into `draft_sessions` (because `league_snapshots` is overwritten on every re-sync, so the archive cannot reference it), and use `ON CONFLICT DO UPDATE` that never overwrites `observed_at` (depends on T020)
- [ ] T054 Wire archive retry into `ensureRunning()` in `src/draft/session.ts` so a session with `completed_at IS NOT NULL AND archived_at IS NULL` finishes archiving on the next cron tick (depends on T053)
- [ ] T055 Call the `shutdown()` RPC from `deleteConnection` in `src/db/leagues.ts`: re-adding a league mints a new connection UUID and therefore a new DO, and an orphaned session would keep polling ESPN forever with no D1 row behind it — a read-only leak against Constitution VI and a cost leak (depends on T024)
- [ ] T056 [P] Credential-sweep test in `tests/draft/no-secrets.test.ts` (FR-024a, mirroring 001's SC-005 grep test): dump the DO storage blob and every D1 draft row and assert neither contains the `espn_s2` or `SWID` values; assert credentials are read per request rather than memoized
- [ ] T057 [P] Isolation test in `tests/draft/isolation.test.ts` (FR-018): a second account gets 404 on every draft route for a league it does not own, **including the WebSocket upgrade**
- [ ] T058 [P] Multi-client test in `tests/draft/multi-client.test.ts` (FR-017): two sockets receive identical frames with identical `seq`; killing one leaves the other unaffected; after the dependency bump, `evictDurableObject(stub, { webSockets: "close" })` confirms hibernate-across-eviction

---

## Phase 9: Polish & Cross-Cutting

- [ ] T059 Add a comment in `src/api/app.ts` recording the standing constraint that **no middleware may mutate the proxied 101 response** — `c.res.headers.set(...)` after `await next()` throws `Can't modify immutable headers` and 500s the upgrade, so a future request-id or CORS decorator would silently kill the draft stream
- [ ] T060 [P] Record the draft-day operational notes for 009 in `specs/005-draft-monitor/quickstart.md`: deploy the DO migration well before draft day (migrations cannot be gradually deployed), no deploys during a draft (a new version restarts every DO and drops every WebSocket), and alarm timing is best-effort with documented delays up to a minute
- [ ] T061 Full sweep: `npm test` (both projects), both tsc configs, eslint, build — all clean; then run every quickstart.md scenario against `wrangler dev`
- [ ] T062 Live validation (SC-011): watch a real ESPN draft through the diagnostic page end to end, confirming every pick, the clock and at least one reconnect by eye against ESPN's own draft room, and record the result in `specs/005-draft-monitor/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Gate 0 (Phase 1)**: no dependencies — **blocks everything**, including Setup. A failed gate ends the feature until `/speckit-clarify` resolves the transport question.
- **Setup (Phase 2)**: after Gate 0 passes.
- **Foundational (Phase 3)**: after Setup — blocks all user stories.
- **US1 (Phase 4)**: after Foundational. No dependency on other stories.
- **US2 (Phase 5)**: after US1 — extends the DO and the socket US1 creates.
- **US3 (Phase 6)**: after Foundational; independent of US2 (touches the cron and RPC, not the socket).
- **US4 (Phase 7)**: after Foundational — the reducer already emits events; this phase finalizes and proves the contract. Independent of US2/US3.
- **Retention (Phase 8)**: after US1 (needs the DO) and Foundational (needs `src/db/draft.ts`).
- **Polish (Phase 9)**: last.

### Within Each User Story

Tests are written and failing before implementation. Pure modules before the DO;
the DO before the API; the API before the web client.

### Parallel Opportunities

- **Phase 2**: T007–T010 are four different files — fully parallel after T006.
- **Phase 3**: the three pure modules are independent — T014/T015 (cadence),
  T016/T017 (snake) and T011/T012 (ESPN types) all run in parallel; only
  T013 and T019 serialize behind them.
- **Phase 4**: T021–T023 in parallel; T030 in parallel with the DO work.
- **Phase 5**: all four tests (T032–T035) in parallel.
- **Phase 7**: all three tests (T046–T048) in parallel.
- **Phase 8**: T052, T056, T057, T058 in parallel.
- **Across stories**: US3 and US4 can proceed in parallel with US2 — different
  files, no shared state.

---

## Parallel Example: Phase 3 (Foundational)

```bash
# Three independent pure modules, each test-first:
Task: "Unit tests for cadence in tests/unit/cadence.test.ts"
Task: "Unit tests for snake projection in tests/unit/snake.test.ts"
Task: "Extend src/espn/types.ts with the captured picks shape"
```

---

## Implementation Strategy

### Gate first

Run Phase 1 alone. Do not write a line of DO code before T003's verdict — if
`mDraftDetail` is frozen during live drafts, every task after Phase 2 is wasted
work.

### MVP (Gate 0 → Phase 4)

Gate 0 → Setup → Foundational → US1. That is a working live draft monitor with a
plain page you can watch. Stop, validate against quickstart scenarios 1–2, and
demo.

### Incremental delivery

1. Gate 0 + Setup + Foundational → the brain, fully tested, no platform.
2. + US1 → watchable live draft (**MVP**).
3. + US2 → trustworthy when things break.
4. + US3 → no draft-day ritual.
5. + US4 → contract 006/007/008 build on.
6. + Retention → 008 inherits a corpus; nothing leaks or polls forever.

### Notes

- `[P]` = different files, no dependencies.
- The pure modules (`reconcile.ts`, `cadence.ts`, `snake.ts`) must not import
  anything from the Workers platform. If a task tempts you to, the logic is in
  the wrong file.
- Commit after each task or logical group.
