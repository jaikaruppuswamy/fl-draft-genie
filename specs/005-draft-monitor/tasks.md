---

description: "Task list for 005-draft-monitor"
---

# Tasks: Draft Monitor (005)

**Input**: Design documents from `specs/005-draft-monitor/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/api.md](contracts/api.md), [quickstart.md](quickstart.md) — and the deployed 001/002 build (connections, credentials, player board).

> **Regenerated 2026-08-05 against the round-4 plan.** The previous list was
> written for a polling design that Gate 0 disproved: its open tasks descended
> from a `mDraftDetail` poll loop, a four-tier cadence function and a Gate 0
> capture that produced frozen skeletons. None of that survives. What does
> survive — the pure reducer, the snake projection, the event model, WebSocket
> delivery, the D1 archive — is carried forward here with its reasoning intact.

**Tests**: requested. The spec defines SC-001…SC-011 as measurable outcomes and
FR-021 requires offline replay, so test tasks are first-class and — for the feed
and the reducer — written **before** the implementation they cover.

## Format: `[ID] [P?] [Story] Description`

- **[P]** — parallelisable (different files, no dependency on an incomplete task)
- **[US1]…[US4]** — the user story a task serves; absent for Setup, Foundational and Polish

## Path Conventions

Single Cloudflare Worker + React SPA, as in 001–004: `src/` (Worker), `web/src/`
(SPA), `tests/` (Vitest), `migrations/` (D1). New module tree `src/draft/`.

## Prerequisites already satisfied

Do **not** re-do these; they are why this feature is unblocked.

- **Gate 0** — closed, FAILED (2026-08-03). Do not attempt to poll for live picks.
- **The transport** — `010-draft-tap` is built, deployed, and has fed two real drafts.
- **The corpus** — `tests/fixtures/tap/replay-full.jsonl` (72 live messages) and
  `tests/fixtures/tap/oracle-live-2026.json` (the same draft as ESPN reported it
  afterwards, produced by a different mechanism — which is what makes SC-010
  meaningful rather than circular).
- **The heartbeat** — tap 0.1.6 emits periodic liveness with a `hidden` flag
  (010 FR-015a). FR-007c/e are buildable against a real signal.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add the `DRAFT_SESSION` Durable Object binding to `wrangler.jsonc` using the **legacy `migrations` array with `new_sqlite_classes`**, never `exports`. 010's research established empirically that `exports` silently provisions a **KV-backed** DO under the installed vitest pool while production is SQLite-backed — the suite would pass against a different storage engine than production runs
- [X] T002 Extend `src/env.ts` with the `DRAFT_SESSION: DurableObjectNamespace` binding
- [X] T003 [P] Create `vitest.draft.config.ts` as a third project with `isolatedStorage: false`, and add a matching **exclude** to `vitest.workers.config.ts`. Its include glob is already `tests/**/*.test.ts`, which matches `tests/draft/**`, so without the exclude every DO test also runs under the isolated-storage project that cannot support WebSockets
- [ ] T004 [P] **BLOCKED — needs a vitest 4 migration, which is a separate decision.** The intent was to bump `@cloudflare/vitest-pool-workers` in `package.json` to get `evictDurableObject` for T041. **It is not obtainable on vitest 3**: the highest vitest-3-compatible release is `0.12.21` (peer `2.0.x - 3.2.x`) and its public `cloudflare:test` API exports only `listDurableObjectIds`, `runInDurableObject`, `runDurableObjectAlarm`, `createExecutionContext`, `waitOnExecutionContext`, `fetchMock`, `SELF`, `env` — no eviction helper. Everything from `0.13.0` requires `vitest ^4.1.0`, and this repo is on `3.2.7` across 45 test files. Trialled `0.12.21`: all 315 tests passed, but it emits a non-ASCII header warning for **every** test name containing an em dash — which this suite uses heavily — burying real output. Reverted to `0.8.71`. T041 is rewritten to assert the property without the API
- [X] T005 Write `migrations/0008_draft.sql`: `draft_sessions` (cron work-list, cascades from `league_connections`) plus the three-table archive `draft_archives` + `draft_picks` + `draft_keepers`, all keyed by `account_id` and cascading from `accounts` with **no FK to `league_connections`** — disconnecting a league must not destroy retained history (research §5). Numbered 0008 because 010 took 0006 and 0007

**Checkpoint**: bindings and schema exist; nothing behavioural yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the pure core. Everything here imports **nothing from the
platform** — that rule is what makes FR-021 (offline replay) true by
construction and keeps the DO a thin shell. 010 proved its value the hard way:
its draft-end detection was four lines inside the impure shell where nothing
could test it, and it shipped wrong in two ways that one test would have caught.

**⚠️ No user story work begins until this phase is complete.**

- [X] T006 [P] Unit tests for the snake projection in `tests/unit/snake.test.ts`: `teamAt(n)` across both directions of the serpentine, observed fact preferred below the frontier, projection above it, and `orderTrust` degrading to `unknown` when the published order is absent
- [X] T007 [P] Implement pure `src/draft/snake.ts` — `teamAt()`, `picksUntilTurn()`, `remainingSchedule()`, `orderTrust` tri-state (T006 failing first)
- [X] T008 [P] Unit tests for the feed cursor in `tests/unit/feed.test.ts`: keyset ordering over `(received_at, id)`, a batch inserted mid-read is **not** skipped, ties on identical `received_at` resolve by `id`, and the cursor does **not** advance until the batch is committed
- [X] T009 [P] Implement pure `src/draft/feed.ts` — cursor arithmetic and batch→observation mapping (T008 failing first). **Empty slots are the `-1` sentinel; never filter on sign.** D/ST ids are legitimately near −16000, and `playerId > 0` is what made 010's capture script report 66 of 72 picks for a complete draft
- [X] T010 [P] Unit tests for liveness in `tests/unit/liveness.test.ts`: a 45 s heartbeat gap on a **visible** tab lapses; the same gap on a **hidden** tab does **not** (150 s does); and a 90 s gap **between picks** with heartbeats still arriving never lapses. That last case is the false alarm a silence-based rule raises on every slow human round
- [X] T011 [P] Implement pure `src/draft/liveness.ts` — lapse evaluation over `{ lastHeartbeatAt, hidden, now }` plus FR-007f's withholding predicate (T010 failing first)
- [X] T012 [P] Unit tests for `src/draft/schedule.ts` in `tests/unit/schedule.test.ts`: the ESPN back-off ladder 5→10→20→40→60 s capped, reset on first success, `espn_rejected` climbing it and `league_not_found` going terminal rather than hammering a 404 forever
- [X] T013 [P] Implement pure `src/draft/schedule.ts` — pre-draft refresh cadence and the back-off ladder (T012 failing first). This is what remains of the retired four-tier cadence: it governs ESPN reads only, never picks
- [X] T014 Unit tests for the reducer in `tests/unit/reconcile.test.ts` — **the heart of the feature**: pure append, no-op idempotency (a re-read batch must produce **zero** events), out-of-order arrival, duplicate picks from two tabs collapsing on pick identity, a removed pick bumping the revision and replaying affected turns, and `on_deck` firing exactly once per turn **per revision**
- [X] T015 Implement the pure reducer `src/draft/reconcile.ts`: `(state, observation) → (state, events[])`. Identity is the **player id** (FR-005a) — never field 3, which the independent oracle disproved as the round at 5/70 and which `contracts/ingest.md` requires be carried opaquely
- [X] T016 [P] Extend `src/espn/types.ts` with the **completed** `draftDetail.picks[]` shape and `mRoster` entries — the post-completion flush is the one thing Gate 0 proved ESPN writes reliably
- [X] T017 [P] Implement `parseCompletedDraft()` in `src/espn/parsers.ts` for the completion oracle, with unit tests in `tests/unit/parsers.test.ts` asserting D/ST negatives survive parsing
- [X] T018 Implement `src/db/draft.ts`: `draft_sessions` header upsert, the cron work-list query (`archived_at IS NULL AND status NOT IN ('aborted','unsupported')`), and archive reads/writes
- [X] T019 Extend `src/db/tap.ts` with the keyset cursor read over `tap_batches`, with tests in `tests/contract/tap-feed.test.ts` that write rows directly and assert what comes back

**Checkpoint**: the entire draft brain is implemented and tested with no Durable
Object in sight. SC-010's replay check (T028) becomes runnable as soon as the
session exists.

---

## Phase 3: User Story 1 — Follow a live draft pick by pick (Priority: P1) 🎯 MVP

**Goal**: every pick appears, in order, with who is on the clock and how many
picks remain until the owner's turn.

**Independent test**: replay the committed corpus through the session and assert
the resulting state matches the independent oracle — no browser, no live draft.

- [X] T020 [US1] Contract test in `tests/draft/feed-order.test.ts`: `/api/tap/batch` writes to `tap_batches` and acks **before** nudging, an unavailable session does **not** delay `accepted_through`, and a batch acked but never nudged still lands within the 5 s safety alarm. Deliberately drop the nudge and assert no pick is lost — only delayed
- [X] T021 [US1] Implement `src/draft/session.ts` — the `DraftSession` DO shell: `nudge()`, the cursor pull, `reconcile()` invocation, and the commit. **Broadcast after the commit, never inside it** (research §7)
- [X] T022 [US1] Extend `src/api/tap.ts` to nudge the session via `ctx.waitUntil` **after** the 202. The ack must not wait on the DO, or a restarting object stalls the tap's buffer — the outcome FR-008's buffering guarantees exist to prevent
- [X] T023 [US1] Implement the 5 s safety alarm in `src/draft/session.ts`, scheduled **only while the room is open**. SC-001 promises 100% within 10 s and a lost nudge must not breach it, so the ceiling is enforced by a timer rather than by assuming `waitUntil` always runs
- [X] T024 [US1] Do **not** persist on a no-op observation in `src/draft/session.ts` — gate the transaction on `events.length > 0 || orderChanged || statusChanged`, or every safety-alarm sweep that finds the cursor already current commits pointlessly (research §7)
- [X] T025 [P] [US1] Implement `src/api/draft.ts`: `GET /api/leagues/:id/draft` (status) and `/draft/snapshot`, per [contracts/api.md](contracts/api.md)
- [X] T026 [US1] Mount `/api/leagues/:id/draft` in `src/api/app.ts` and re-export `DraftSession` from `src/index.ts`
- [X] T027 [P] [US1] Implement `web/src/pages/DraftDiagnostics.tsx` — the deliberately plain throwaway page (FR-025): session status, live pick feed, on-the-clock, picks-until-your-turn, staleness age. Not styled to the design system; 007 replaces it wholesale
- [X] T028 [US1] Integration test in `tests/draft/replay-live.test.ts`: feed `tests/fixtures/tap/replay-full.jsonl` through the session and assert the final state matches `oracle-live-2026.json` on all 72 picks — including the 3 that arrived **only** in a ledger

**Checkpoint**: US1 is independently demonstrable from the corpus alone.

---

## Phase 4: User Story 2 — Survive reloads, disconnects and crashes (Priority: P2)

**Goal**: state survives a client reload, a network drop, and the loss of the
session itself.

**Independent test**: destroy the DO mid-replay; the rebuilt state matches the
incrementally-built one on `stateFingerprint`.

- [X] T029 [P] [US2] Implement WebSocket delivery in `src/draft/session.ts` using the **Hibernation API** (`ctx.acceptWebSocket`). `server.accept()` sockets are invisible to `ctx.getWebSockets()` and so cannot be enumerated after a restart
- [X] T030 [US2] Implement the snapshot-then-cursor hand-off and `?since=` resume over the event window in `src/draft/session.ts`, per [contracts/api.md](contracts/api.md)
- [X] T031 [P] [US2] Implement `web/src/lib/draftSocket.ts` — reconnect with cursor resume and a bounded back-off
- [X] T032 [US2] Implement rebuild-from-log in `src/draft/session.ts`: replay `tap_batches` through the **same cursor read the live path uses**. There must be no second restore routine — the path that only runs in emergencies is the one that rots
- [X] T033 [US2] Reconcile a freshly arrived full ledger against rebuilt state in `src/draft/reconcile.ts` and correct divergence through the revision mechanism (FR-012/FR-019)
- [X] T034 [US2] Test in `tests/draft/rebuild.test.ts`: rebuilt state equals incrementally-built state on `stateFingerprint`, which **excludes** the delivery cursor and event log — a rebuild collapses N observations into one and provably cannot reproduce the original event stream (research §7, FR-014)
- [X] T035 [US2] Mirror `observed_at` to D1 **first-seen-wins** in `src/db/draft.ts` (`ON CONFLICT DO UPDATE` that never overwrites it). After a cold rebuild every pick otherwise carries one observation time, destroying the per-pick timing 008's replay lab needs
- [X] T036 [US2] Test in `tests/draft/reconnect.test.ts`: a client reconnecting mid-draft receives a complete snapshot with zero missing picks, and an event-window overflow forces a fresh snapshot rather than a silent gap

**Checkpoint**: US1 + US2 — the monitor is correct when things go wrong, which is the only condition that matters on draft day.

---

## Phase 5: User Story 3 — The session arms itself before the draft (Priority: P3)

**Goal**: the owner starts nothing, and a missing tap is visible before the first pick.

**Independent test**: a heartbeat with no session creates one and fetches the
published order.

- [X] T037 [US3] Implement lazy arming (FR-007g) in `src/api/tap.ts` and `src/draft/session.ts`: the **first frame from a tap — heartbeat included — arms the session**. Because the tap heartbeats from the moment the draft room opens, the session exists *before* the first pick, so a missing or broken tap is visible while there is still time to fix it
- [X] T038 [US3] On arming, fetch the pre-draft data ESPN still exposes in `src/draft/session.ts` — draft type, scheduled time, published order, teams (FR-007b). Gate 0 disproved live pick visibility, **not** pre-draft reads
- [X] T039 [US3] Implement heartbeat ingestion and lapse detection in `src/draft/session.ts`: a 15 s liveness alarm applying **45 s visible / 150 s hidden**, driving the `not_receiving` state (FR-007c/e). The two thresholds are not redundancy — a hidden tab's timers throttle to ~1/minute, and the ratified design *expects* that tab to be backgrounded
- [X] T040 [US3] Implement the withholding rule (FR-007f) in `src/draft/liveness.ts` and surface it through `src/api/draft.ts`: `incompatible` and `version-rejected` withhold recommendations; `buffering` and `draft-end-unknown` do **not**. Assert **both** directions (SC-001c) — a rule that only ever withholds is as wrong as one that never does, because withholding through an ordinary outage makes the feature look broken during the one hour it matters
- [X] T041 [US3] Test session survival across loss in `tests/draft/eviction.test.ts` **without** `evictDurableObject`, which is unavailable on vitest 3 (see T004). The property that matters is not the eviction mechanism but the rebuild: construct a **fresh** DO stub for the same id, replay `tap_batches` through the cursor, and assert the rebuilt state matches the incrementally-built one on `stateFingerprint`. That exercises exactly what an eviction would trigger, and does so deterministically rather than depending on a runtime hint
- [X] T042 [P] [US3] Extend `src/sync/predraft.ts` — the 5-minute cron restores dead sessions with no client attached, re-arming **only when `getAlarm()` is null AND `completed_at IS NULL`**; without the second condition the cron resumes a finished draft
- [X] T043 [US3] Implement the armed absolute deadline `scheduled_at + 6 h` → `aborted` in `src/draft/session.ts`, with re-arm driven by a league re-sync publishing a different `draft_at`. A session stuck `armed` burns ~11,000 GB-s/day

**Checkpoint**: US1 + US2 + US3 — draft day needs no human action.

---

## Phase 6: User Story 4 — Events the engine and UI can build on (Priority: P4)

**Goal**: the ordered event contract that 006 and 007 are built against.

**Independent test**: replaying the corpus emits exactly one `on_deck` before
each `on_the_clock`, per revision.

- [ ] T044 [US4] Test in `tests/draft/events.test.ts` (SC-003, SC-010): across the replayed corpus every owner turn has exactly one `on_deck` before its `on_the_clock` **within each revision** — none skipped, none duplicated, none out of order — compared against `oracle-live-2026.json`, never against the replay itself
- [ ] T045 [US4] Implement the ordinal `on_deck` guarantee in `src/draft/reconcile.ts`: fires as early as the draft's structure allows, at most two picks ahead, always exactly once and always before `on_the_clock`, carrying the real `picks_until` (2, 1 or 0). At snake round boundaries the owner picks back-to-back and two-ahead is structurally impossible
- [ ] T046 [US4] Emit `draft_complete` from `src/draft/reconcile.ts` and publish the event contract documented in [contracts/api.md](contracts/api.md) for 006/008
- [ ] T047 [P] [US4] Test in `tests/unit/reconcile.test.ts` that consumers can dedupe on `(revision, kind, overall)` and that a revision bump reads as "rewind and re-apply"

**Checkpoint**: all four stories complete; the contract 006 depends on is fixed.

---

## Phase 7: Archive, oracle and hardening

- [ ] T048 Implement `src/draft/archive.ts`: on `drafted`, fetch the authoritative post-completion `mDraftDetail` and **reconcile the tap-built draft against it before archiving**. 010 used this oracle in tests, where it earned its keep twice — disproving the field-3 reading (5/70) and confirming the ledger offsets (31/31). Self-consistency cannot catch a systematically missed pick; an independent source can
- [ ] T049 Bump the revision through the existing correction path on divergence in `src/draft/archive.ts`, and record the divergence rather than silently preferring one source
- [ ] T050 [P] Write the archive in chunked batches, first-seen-wins, in `src/db/draft.ts`; retained **indefinitely** as season history (ratified 2026-08-02)
- [ ] T051 Call `shutdown()` (deleteAlarm + deleteAll, refuse to re-arm) from `deleteConnection` in `src/db/leagues.ts`. Re-adding a league mints a new connection UUID and hence a new DO; an orphaned session would keep reading D1 and ESPN forever with no row behind it
- [ ] T052 [P] Credential-sweep test in `tests/draft/no-secrets.test.ts`: `JSON.stringify(state)` contains neither `espn_s2` nor `SWID`, mirroring 001's SC-005
- [ ] T053 [P] Assert the ESPN rate bound (SC-008) structurally in `tests/draft/rate-bound.test.ts` with `fetchMock` + `disableNetConnect()`: **≤ 5 requests/minute per league**, at most one in flight, and **zero ESPN requests on the pick path**

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T054 [P] Measure SC-001 over the replayed corpus in `tests/draft/latency.test.ts` — p95 ≤ 2 s and 100% ≤ 10 s from `observed_at` to delivery — and record the numbers, as 010 did (median 0.202 s, p95 0.223 s)
- [ ] T055 [P] Verify SC-001b end-to-end in `tests/draft/liveness-e2e.test.ts` against the real tap heartbeat now that 0.1.6 emits it, including the hidden-tab threshold
- [ ] T056 [P] Update `specs/005-draft-monitor/quickstart.md` with any drift found while implementing, and record draft-day notes for 009's runbook
- [ ] T057 Run the full suite plus `scripts/privacy-sweep.ts`; confirm no fixture added by this feature carries a real identifier or member name

---

## Dependencies & Execution Order

```text
Phase 1 (Setup) ─▶ Phase 2 (Foundational, BLOCKING)
                      │
                      ├─▶ Phase 3 US1 (P1) ─┬─▶ Phase 4 US2 (P2)
                      │                     └─▶ Phase 5 US3 (P3)
                      │                              │
                      └──────────────────────────────┴─▶ Phase 6 US4 (P4)
                                                            │
                                                     Phase 7 ─▶ Phase 8
```

### Phase Dependencies

- **Phase 2 blocks everything.** No story work begins until the pure core is done.
- **US2 and US3 both depend on US1's session existing**, but not on each other.
- **US4 depends on the reducer (Phase 2), not on US2/US3** — its events are
  emitted by the same reduce step US1 already drives. It ranks last as a *slice*
  because it has little standalone UI, not because it is technically blocked.

### Within Each User Story

Tests → pure logic → session wiring → API → UI.

### Parallel Opportunities

- **Phase 2 is almost entirely parallel**: T006–T013 are five independent pure
  modules with their tests. T014/T015 (the reducer) are sequential against each
  other and are the critical path.
- **Phase 3**: T025 and T027 are independent of the session internals.
- **Phase 7**: T050, T052 and T053 touch different files.

## Parallel Example: Phase 2

```text
# Five pure modules, no shared files:
T006 + T007  snake.ts
T008 + T009  feed.ts
T010 + T011  liveness.ts
T012 + T013  schedule.ts
T016 + T017  espn types/parsers

# Critical path, sequential:
T014 ─▶ T015  reconcile.ts
```

## Implementation Strategy

### MVP

**Phase 1 + Phase 2 + Phase 3 (US1).** That yields a live draft board fed by the
real tap, verifiable against the committed corpus with no live draft required.
It is independently valuable — "what's gone, what's left, when am I up" beats
tabbing between ESPN and a spreadsheet — and it is the prerequisite for 006.

### Incremental delivery

**Then US2** — Constitution V. A monitor that is correct only while nothing goes
wrong is not a draft-day monitor. **Then US3, then US4.**

## Notes

- **Never filter picks on sign.** `-1` is the empty sentinel; D/ST ids are near
  −16000. This rule has already been broken twice in this project — once in
  010's capture script, once in this feature's own data model.
- **Field 3 is unresolved.** It is not the round (5/70 against the oracle) and
  nothing may depend on it. Carry it opaquely.
- **Compare against the oracle, never against the replay.** Validating the
  corpus against itself proves nothing.
- **`observed_at` is comparable only within one `epoch`.** The tap re-anchors its
  clock across sleep; stamps from different epochs are not one timeline.
- **No live draft is needed** to build or test any task here.
