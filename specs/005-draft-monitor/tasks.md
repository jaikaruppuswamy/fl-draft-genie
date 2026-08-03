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

**Revision (2026-08-02)**: renumbered after `/speckit-analyze`. Batch 1
remediation applied — fixture sanitization (was a constitution violation),
archive metadata moved off the cascade path, terminal-state guards on the poll
alarm, the restore predicate de-contradicted, the ESPN rate bound and back-off
ladder given values in plan.md, and three tasks added (T005, T028, T061).
Spec-level findings (FR-020's two-picks claim, FR-019 vs corrections, SC-001's
"100%") are deliberately **not** addressed here — they belong to a
`/speckit-clarify` pass.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 per spec.md

---

## Phase 1: Gate 0 — Validate the premise (BLOCKING, stop-the-line)

**Purpose**: Establish that ESPN's `mDraftDetail` reflects picks *during* a
draft. It is not established (research §0), and if it is false this feature's
design does not work. Nothing else starts until this passes.

- [X] T001 Write a read-only capture script `scripts/capture-draft.ts` that pulls `mDraftDetail`, `mSettings`, `mTeam` and `mRoster` for a given connection through the existing `src/espn/client.ts` and writes timestamped JSON under `tests/fixtures/espn/draft/` — **sanitizing on write, before any bytes reach the repo**. Every `members[].id` and `teams[].owners[]` GUID (these **are SWIDs**), every `displayName`/`firstName`/`lastName`, and every league and team name is replaced. The mapping MUST be **deterministically derived, never persisted**: order teams by ESPN `teamId` ascending and assign index *n* = 1..N, then emit GUID `{00000000-0000-4000-8000-0000000000NN}` (NN = zero-padded *n*), manager `Manager n`, team `Team n`, league `Test League` — except the connection's own team, which maps to the README's existing `{11111111-2222-3333-4444-555555555555}`. Recomputing the derivation gives the same mapping every run, so **no lookup table of real GUIDs exists to be committed**. Append this rule to `tests/fixtures/espn/README.md` so T006's gate and T058 have a real reference set to check against. Never print cookies. Committing a raw capture violates the constitution's Security & Privacy constraint and 001's house norm
- [X] T002 Run the capture against a real ESPN draft (a mock draft in a connected league is sufficient) — **sampling continuously at a fixed short interval (≤ 5 s) for the whole draft, not at a handful of moments**, because SC-003's separate-observation clause and SC-010's replay corpus are both defined over a continuous observation sequence and a sparse capture collapses every event into batches. Retain the four named landmarks (order-published+skeleton, room-open with zero filled picks, mid-draft, complete) as `tests/fixtures/espn/draft/{order,open,mid,complete}.json`
- [X] T003 Record the verdict in `specs/005-draft-monitor/research.md` §0 under a new "Gate 0 result" heading: does `picks[]` with `playerId > 0` grow between successive mid-draft samples? **If NO — STOP and run `/speckit-clarify`**; SC-001 is unachievable by polling and the alternative transport raises a Constitution VI question this plan does not answer. Write the verdict in placeholder terms only — no real GUIDs, manager names, or league/team names in prose (the same obligation the fixtures carry)
- [X] T004 With the capture in hand, resolve the three UNVERIFIED items in research §4 and update it in place — placeholder terms only, as T003: (a) is skeleton `teamId` pre-filled on empty snake slots, (b) do keepers occupy real `overallPickNumber` slots in `picks[]` or appear only in `roster.entries[]`, (c) what `autoDraftTypeId` values actually appear
- [ ] T005 Produce the keeper fixture that T024 and quickstart scenario 2 both require, in `tests/fixtures/espn/draft/keepers.json`: capture from a **real keeper league** if one is connected — **via `scripts/capture-draft.ts`, same derived mapping** — because a fresh mock draft structurally cannot contain keepers, so T004(b) cannot be answered from T002's capture alone. If no keeper league is available, hand-author the fixture to the shape research §4 describes using the same placeholder derivation, and record in research §4 that the keeper path ships **verified against a hand-authored fixture only**
- [ ] T006 Assemble the full-draft replay corpus `tests/fixtures/espn/draft/replay-full.json` from the **already-sanitized** T002 samples (so the committed corpus inherits the same derived mapping); then **run the sanitization gate before the first commit of Phase 1** — a Node-side script (not a Workers-pool test; workerd has no `node:fs`) that walks `tests/fixtures/espn/draft/**` and fails on any GUID outside the derived set **or any string matching the real manager/team/league names supplied to the capture**. T058 re-asserts this in CI, but the gate that matters is this one: a raw capture committed once lives in git history permanently

**Checkpoint**: ⛔ **GATE 0 FAILED (2026-08-03).** `mDraftDetail` does not
reflect picks during a live snake draft — ~30 real picks over 17.5 minutes,
207 samples, zero observable. See research.md §0 "Gate 0 result".

**Phases 2–9 are BLOCKED.** Do not start T007. US1, US2 and US4 have no data
source, and SC-001/SC-002/SC-003 are unachievable as specified.

Before `/speckit-clarify` can frame the right question, one experiment remains:
the capture polled `mDraftDetail` alone on samples 2..207, so whether
`mRoster`/`mTeam` move during a draft is **untested**. `capture-draft.ts` now
requests all four views per sample (no extra requests — ESPN combines `view=`
params) and reports per-section change detection; `probe-draft.ts` answers it
in one request against a draft stopped mid-way with picks already made.

- If rosters move live → the poll *source* changes; most of the design survives.
- If nothing in the v3 read API moves → transport question (draft-room
  WebSocket, unresolved Constitution VI) or re-scope.

T005 (keeper fixture) and T006 (replay corpus) are moot until a source exists —
a corpus of frozen skeletons has nothing to replay.

---

## Phase 2: Setup

- [ ] T007 Add the Durable Object to `wrangler.jsonc`: `durable_objects.bindings` `{ name: "DRAFT_SESSION", class_name: "DraftSession" }` plus `migrations: [{ tag: "v1", new_sqlite_classes: ["DraftSession"] }]` — **use the legacy `migrations` array, not the `exports` field** (research §1: `exports` silently provisions a KV-backed DO under the installed test pool while production is SQLite-backed)
- [ ] T008 [P] Create `migrations/0005_draft.sql` per data-model.md: `draft_sessions` (PK connection_id FK→league_connections CASCADE, account_id FK→accounts CASCADE, status CHECK, scheduled_at, last_observed_at, pick_count, completed_at, archived_at) + `idx_draft_sessions_open`; and the account-keyed archive `draft_archives` (PK `(account_id, connection_id, season)`, plus **espn_league_id**, league_name, team_count, **my_team_id, order_json, teams_json**, format, completed_at, archived_at, and an index on `(account_id, espn_league_id, season)`), `draft_picks`, `draft_keepers` — each of the three carrying `account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE` (the `0001_init.sql` convention) and **no FK to league_connections**, so deleting an account still removes everything while disconnecting a league cannot delete retained history. The three metadata columns belong in `draft_archives`, **not** `draft_sessions`, which cascades away with the connection. Apply locally
- [ ] T009 [P] Extend `src/env.ts` with `DRAFT_SESSION: DurableObjectNamespace<DraftSession>` using a **type-only** import to avoid a runtime cycle, and re-export the `DraftSession` class from `src/index.ts` (which currently exports only `default`)
- [ ] T010 [P] Create `vitest.draft.config.ts` at repo root (**not** in a subdirectory — the pool resolves `wrangler.configPath` relative to the config file's own directory) covering `tests/draft/**` with `isolatedStorage: false`, **add a matching exclude to the existing `vitest.config.ts`** — written as `exclude: [...configDefaults.exclude, "tests/draft/**"]`, because setting `test.exclude` *replaces* Vitest's defaults (node_modules, dist, …) rather than extending them — since its glob is already `tests/**/*.test.ts`, so without this every DO test also runs under the isolated-storage project that cannot support WebSockets. Wire both projects into `npm test` in `package.json`, alongside the Node-side fixture gate from T006
- [ ] T011 [P] Bump `@cloudflare/vitest-pool-workers` past 0.8.71 so `evictDurableObject` exists, and confirm the existing suite still passes on the new version before any DO code depends on it

---

## Phase 3: Foundational (Blocking Prerequisites)

**Purpose**: The pure core. `reconcile.ts`, `cadence.ts` and `snake.ts` import
**nothing from the platform** — that rule is what makes FR-021 true by
construction and keeps the DO a thin shell.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [ ] T012 [P] Extend `src/espn/types.ts` with the real `draftDetail.picks[]` shape captured in Gate 0 (playerId, teamId, roundId, roundPickNumber, overallPickNumber, keeper, autoDraftTypeId, bidAmount, nominatingTeamId) and `mRoster`'s `teams[].roster.entries[]`
- [ ] T013 [P] Extend `src/espn/client.ts` with the `mRoster` view (new to this repo) — read-only, no new write methods
- [ ] T014 Implement `parseDraftObservation()` in `src/espn/parsers.ts`: filter to `playerId > 0` (D/ST ids are legitimately **negative**, so never `!== -1`), map picks to the internal shape, union keeper picks with `roster.entries` by `playerId`, and route `bidAmount`/`nominatingTeamId` into the format-specific `detail` slot rather than the shared shape (depends on T012, T013)
- [ ] T015 [P] Unit tests for the cadence function in `tests/unit/cadence.test.ts`: 60 s armed, 30 s unattended, 10 s attended, 3 s within 3 picks; the plan's back-off ladder (5→10→20→40→60 s cap, reset on first success); `league_not_found` goes terminal rather than climbing; **`complete`/`aborted`/`unsupported` yield no next alarm at all** (FR-005/FR-008); re-anchor when more than one interval behind (no catch-up burst)
- [ ] T016 [P] Implement pure `nextPollDelayMs()` in `src/draft/cadence.ts` over `{ status, clientsAttached, picksUntilTurn, consecutiveErrors, dueAt, now }`, returning an explicit terminal signal for `complete`/`aborted`/`unsupported` — constants only, no config surface (Constitution IV) (tests T015 failing first)
- [ ] T017 [P] Unit tests for snake projection in `tests/unit/snake.test.ts`: `teamAt(n)` for both directions of the serpentine, observed fact preferred below the frontier, skeleton `teamId` preferred over projection, `orderTrust` degrading to `unknown` when the order is absent, remaining-schedule generation, and traded-pick divergence yielding `projected` rather than `observed`
- [ ] T018 [P] Implement pure `src/draft/snake.ts`: `teamAt()`, `picksUntilTurn()`, `remainingSchedule()`, `orderTrust` tri-state (tests T017 failing first)
- [ ] T019 Unit tests for the reducer in `tests/unit/reconcile.test.ts` — the heart of the feature: pure append (`c == m`), no-op idempotency (`c == m == n` ⇒ **zero** events, no persist), correction (`c < m` ⇒ list surgery + one `draft_revised`, marks cleared above `c`, no retraction), batched observation revealing five picks (every implied event in order, `on_deck` never skipped, shared `observed_at`), turn-boundary collapse (`picks_until` legitimately 0 at snake round turns), and the stale-observation guard (`obsSeq > lastObsSeq` prevents a phantom undo)
- [ ] T020 Implement the pure reducer `src/draft/reconcile.ts`: `(state, observation) → (state, events[])` via longest-common-prefix + one-step-at-a-time pointer replay guarded by the persisted `turn_marks` set; assign `(epoch, seq)`; append to the 500-event `event_window` with oldest-evicted; compute `stateFingerprint` **excluding** epoch/seq/revision/observed_at/turn_marks/event log per data-model.md (depends on T014, T018; tests T019 failing first)
- [ ] T021 [P] Implement `src/db/draft.ts`: `draft_sessions` header upsert, the cron work-list query (`archived_at IS NULL AND status NOT IN ('aborted','unsupported')`), a **second query for the rescheduled-draft re-arm** — `aborted` sessions joined to `league_snapshots.draft_at` where the snapshot's draft time differs from the session's `scheduled_at`, which the work-list predicate deliberately excludes — the `draft_archives` writes, and per-account-scoped reads for the API layer

**Checkpoint**: The entire draft brain is implemented and tested with no Durable Object in sight.

---

## Phase 4: User Story 1 - Follow a live draft pick by pick (Priority: P1) 🎯 MVP

**Goal**: Every pick, roster, on-the-clock team, available pool and
picks-until-my-turn visible and updating without user action.

**Independent Test**: Quickstart scenarios 1, 2 and 13 — replay the captured
mid-draft sequence and confirm state matches ESPN throughout, keepers count
once, and an auction league reports unsupported.

### Tests for User Story 1

- [ ] T022 [P] [US1] Contract tests in `tests/draft/api-draft.test.ts` for `GET /api/leagues/:id/draft`, `/snapshot` and `POST /open` per contracts/api.md, including `status: "unsupported"` for an auction league (opens no session, arms no alarm) and 404 for a connection owned by another account
- [ ] T023 [P] [US1] Integration test in `tests/draft/live-tracking.test.ts`: drive a session through the captured mid-draft observations and assert picks, rosters, on-the-clock team, picks-until-my-turn and the available set at each step
- [ ] T024 [P] [US1] Keeper test in `tests/draft/keepers.test.ts` against the T005 fixture: pre-draft rostered players are unavailable and attributed from pick one, and are counted **once** even when they appear in both `picks[]` and `roster.entries[]`

### Implementation for User Story 1

- [ ] T025 [US1] Create the `DraftSession` DO in `src/draft/session.ts`: SQLite-backed, live state as one JSON blob under key `"session"` in the synchronous `ctx.storage.kv` API, with the RPC surface `ensureRunning()` / `snapshot()` / `shutdown()`
- [ ] T026 [US1] Implement the alarm loop in `src/draft/session.ts` with all four research §2 corrections: **arm the safety alarm as the first statement of `alarm()`** (the pending alarm is consumed on entry, so a mid-handler shutdown otherwise kills polling until the cron), `alarm()` never rethrows (an uncaught throw triggers at-least-once retry and re-polls ESPN), re-anchor `dueAt` when behind, and drive the interval from `nextPollDelayMs()` — **including its terminal signal, on which the tail MUST call `deleteAlarm()` explicitly**, not merely skip rescheduling: the safety alarm armed at the top of the handler is already pending by then, so skipping the reschedule still fires one more poll on a completed draft (depends on T016, T025)
- [ ] T027 [US1] Implement the poll path in `src/draft/session.ts`: fetch `?view=mDraftDetail` **alone** while live, decrypt credentials **per request** from D1 and never hold them in DO storage or instance state (FR-024a), feed `parseDraftObservation` → `reconcile`, and gate the persist on `events.length > 0 || orderChanged || statusChanged` (no-op observations must not commit) (depends on T020, T026)
- [ ] T028 [US1] Implement the available-player set in `src/draft/session.ts` and expose it on the snapshot: 002's league board minus every `player_id` in `picks ∪ keepers` (FR-011), derived at read time and never stored, and add the corresponding field to `GET /snapshot` in `specs/005-draft-monitor/contracts/api.md`. The board join happens **DO-side at snapshot time**, so a client never has to reconcile two sources (depends on T027)
- [ ] T029 [US1] Implement the WebSocket upgrade in `src/draft/session.ts` using `ctx.acceptWebSocket()` — the hibernation API is **mandatory**, because `ctx.getWebSockets()` returns 0 for `server.accept()` sockets and FR-007a's attendance-driven cadence depends on it — send the `snapshot` frame inside the handler *before* returning the 101, and define `webSocketClose()`/`webSocketError()` (or every disconnect throws) **without** calling `ws.close(code)` in the body (a browser close surfaces 1005, which throws on the pinned runtime)
- [ ] T030 [US1] Implement broadcast-after-commit in `src/draft/session.ts`: fan out to `ctx.getWebSockets()` only after the state transaction commits, and age out zombie sockets with `setWebSocketAutoResponse()` + `getWebSocketAutoResponseTimestamp()` so a vanished client cannot hold the 10 s tier (depends on T029)
- [ ] T031 [US1] Create `src/api/draft.ts` with the status, snapshot, open and WebSocket-upgrade routes; the upgrade authenticates at the edge and calls the DO with a **synthesized** request carrying no cookie, and mount it in `src/api/app.ts` under `/api/leagues/:id/draft` (the `/api/` prefix is what makes `run_worker_first` route it to the Worker instead of the SPA)
- [ ] T032 [P] [US1] Create `web/src/lib/draftSocket.ts`: connect, hold the `(epoch, seq)` cursor, apply frames, expose state to React, and implement the app-unreachable path from contracts/api.md — reconnect back-off 1→2→4→…→30 s cap, falling back to polling `/snapshot` every 15 s after three consecutive failures
- [ ] T033 [US1] Create the deliberately plain diagnostic page `web/src/pages/DraftDiagnostics.tsx` (FR-025) showing session status, live pick feed, on-the-clock, each team's roster, the available-pool count, picks-until-your-turn and staleness age — plus `last_error`, rendering `espn_rejected` as a **link to credential re-entry** (FR-023's client half) and distinguishing "Draft Genie unreachable" from "ESPN not updating". **Not** styled to the Organic design system and not reusing 007's draft-room design; add its route in `web/src/main.tsx` (depends on T032)

**Checkpoint**: A live draft can be watched end to end. This is the MVP.

---

## Phase 5: User Story 2 - Survive reloads, disconnects, and crashes (Priority: P2)

**Goal**: Reload, network drop, or a destroyed session all return complete,
correct state.

**Independent Test**: Quickstart scenarios 3, 4, 7 and 8 — reload restores in
under 3 s, a destroyed session rebuilds to a matching fingerprint, a 60 s ESPN
outage loses nothing, and a correction reconciles without duplicates.

### Tests for User Story 2

- [ ] T034 [P] [US2] Rebuild test in `tests/draft/rebuild.test.ts`: destroy the DO mid-draft, rebuild from ESPN alone, assert `stateFingerprint` matches the pre-crash value and that the new `epoch` differs (clients take a fresh snapshot by design)
- [ ] T035 [P] [US2] Reconnect test in `tests/draft/reconnect.test.ts`: `?since=N` with an unchanged epoch yields snapshot + only events `> N`; a mismatched epoch forces a full snapshot and cursor reset; **a cursor older than the 500-event window also yields a full snapshot rather than an error**; duplicate frames are discarded rather than triggering a resync storm; mid-draft join yields 100% of prior picks
- [ ] T036 [P] [US2] Outage test in `tests/draft/degraded.test.ts`: with ESPN unreachable for 60 s, state keeps serving with `staleness.degraded` and a rising age, back-off climbs the plan's 5→10→20→40→60 s ladder and resets on first success, and every pick made during the outage appears within one cycle of recovery; `espn_rejected` surfaces as a credential problem distinct from an outage
- [ ] T037 [P] [US2] Correction test in `tests/draft/corrections.test.ts`: an observation with a pick removed or reordered reconciles to ESPN's truth, emits exactly one `draft_revised`, retracts nothing, and produces no duplicate or phantom picks. **Assert the revision semantics of FR-019**: `revision` increments, the turns above the correction point are replayed under the new revision, and a consumer deduping on `(revision, kind, overall)` sees each occurrence exactly once per revision while a consumer assuming per-draft uniqueness would wrongly drop the replay

### Implementation for User Story 2

- [ ] T038 [US2] Implement rebuild-from-ESPN in `src/draft/session.ts`: fetch `mSettings` + `mTeam` + `mRoster` + `mDraftDetail`, rebuild state with no reliance on stored state, regenerate `epoch`, and reset the cursor (depends on T027)
- [ ] T039 [US2] Implement cursor resume in `src/draft/session.ts` and `web/src/lib/draftSocket.ts`: the 500-event retained window, `?since=` handling, epoch-mismatch and out-of-window full resync, and client-side discard of `seq <= cursor` with resync only on a true forward gap (depends on T029, T032)
- [ ] T040 [US2] Implement degraded handling in `src/draft/session.ts`: catch ESPN errors inside `alarm()`, emit a `status` frame rather than throwing, climb the plan's back-off ladder, keep serving last-known state, and distinguish `espn_rejected` (credentials, FR-023) from `espn_unreachable` in both the frame and the status payload (depends on T026)
- [ ] T041 [US2] Add the single in-flight-poll gate and `obsSeq` monotonic guard in `src/draft/session.ts` so a slow ESPN response returning after a newer one cannot be read as a commissioner undo (research §7 — load-bearing correctness, not hygiene)

**Checkpoint**: The monitor is trustworthy when things go wrong, which is the point of Constitution V.

---

## Phase 6: User Story 3 - The session arms itself before the draft (Priority: P3)

**Goal**: No draft-day ritual — sessions arm, capture the order, and go live on
their own.

**Independent Test**: Quickstart scenarios 5 and 13 — the cron arms a scheduled
draft, the order appears when published, the session flips to live, an
unsupported format never opens, and a session destroyed with no client attached
is restored by the cron alone.

**Note**: US3's implementation tasks all edit `src/draft/session.ts`, which US1
creates and US2 also modifies — see Dependencies. These are **not** file-disjoint
from US2.

### Tests for User Story 3

- [ ] T042 [P] [US3] Cron test in `tests/draft/cron-arm.test.ts` (fake clocks): entering the pre-draft window arms a session without any client; the order and the owner's slot appear within one cycle of publication; `inProgress:true` transitions the session to live with no user action; a **rescheduled** draft (new `draft_at` after an abort) re-arms
- [ ] T043 [P] [US3] Unattended-recovery test in `tests/draft/cron-restore.test.ts`: destroy a live session with **no** client connected and assert the cron restores it; a *degraded* session is **not** restored (a `last_observed_at` threshold would rebuild spuriously during an outage); and a **completed** session is not re-armed
- [ ] T044 [US3] Implement `ensureRunning()` in `src/draft/session.ts`: idempotent; evaluate `getAlarm()` **inside** the object under `ctx.blockConcurrencyWhile` (a caller cannot use it as a health check — it returns null while the handler runs); re-arm the poll alarm **only when `getAlarm()` is null AND `completed_at IS NULL`**; when `completed_at IS NOT NULL` take the archive-retry path only and arm nothing; never threshold `last_observed_at`
- [ ] T045 [US3] Extend `src/sync/predraft.ts` with the draft sweep, running **after** the league re-sync so a just-published draft time arms on the same tick: arm supported drafts inside the pre-draft window, re-arm an `aborted` session whose league snapshot now carries a **different** `draft_at` (the rescheduled-draft path), then call `ensureRunning()` across the D1 work-list (depends on T021, T044)
- [ ] T046 [US3] Implement the armed absolute deadline in `src/draft/session.ts`: at **`scheduled_at + 6 hours`** a still-armed session transitions to `aborted` rather than heartbeating forever — without it a single stuck session bills ~11,000 GB-s/day (research §2) — while remaining eligible for the T045 re-arm if a new draft time publishes
- [ ] T047 [US3] Implement the unsupported-format path in `src/draft/session.ts` and `src/api/draft.ts`: auction and offline drafts report `status: "unsupported"`, open no session and arm no alarm, leaving the league fully usable elsewhere (FR-006)

**Checkpoint**: Draft day requires no ritual, and nothing polls forever.

---

## Phase 7: User Story 4 - Events the engine and UI can build on (Priority: P4)

**Goal**: The ordered, exactly-once event stream that 006, 007 and 008 are
built against.

**Independent Test**: Quickstart scenarios 9 and 10 — the full captured draft
replayed through the pure reducer produces exactly the expected sequence.

### Tests for User Story 4

- [ ] T048 [P] [US4] Full-draft replay test in `tests/unit/replay.test.ts` (SC-010, DO-free): the entire `replay-full.json` corpus through `reconcile()` yields one `pick_made` per pick in order, paired `on_deck`/`on_the_clock` per owner turn with none skipped or duplicated **within each revision**, and exactly one terminal `draft_complete`. Also assert the SC-001 latency distribution over the replayed observation timestamps: 95th percentile within the tier bound (12 s baseline / 4 s near-turn), 100% within tier + 60 s — the only place either number is measured
- [ ] T049 [P] [US4] Format-neutrality test in `tests/unit/format-neutral.test.ts` (SC-009a): no shared state field or event payload requires knowing the format is snake; a consumer fed an unfamiliar event kind keeps working; ordinal sequence fields are populated where defined and empty otherwise
- [ ] T050 [P] [US4] Event-payload contract test in `tests/draft/events.test.ts`: every event carries `(epoch, seq, revision, observed_at)`; events from one observation share `observed_at`; `on_deck` fires for **every** owner turn — never suppressed — with `picks_until` reporting the real value including **0** at snake round boundaries; `on_the_clock` carries the remaining schedule; exactly-once holds per `(revision, kind, overall)` rather than per draft

### Implementation for User Story 4

- [ ] T051 [US4] Finalize event payloads in `src/draft/reconcile.ts` to match contracts/api.md exactly — `pick_made`, `on_deck` (with real `picks_until`), `on_the_clock` (with `remaining_schedule`), `draft_complete`, `draft_revised` (depends on T020)
- [ ] T052 [US4] Add the `format` discriminator and the per-entry format-specific `detail` slot throughout `src/draft/reconcile.ts` and `src/db/draft.ts` per FR-006a, with a comment recording that no auction behavior is implemented — only the shape that lets it be added without reworking consumers
- [ ] T053 [P] [US4] Update `specs/005-draft-monitor/contracts/api.md` if Gate 0 changed the event or pick shape, keeping the two downstream contract notes intact: `picks_until` may be 0 (006 must pre-compute its second pick off `on_the_clock(T)`), and unknown event kinds must be tolerated

**Checkpoint**: 006 and 008 have a contract they can build against without a live draft.

---

## Phase 8: Retention & Hardening

**Purpose**: FR-013's forever-archive and the security/lifecycle edges. These
serve no single story but the feature is not done without them.

- [ ] T054 [P] Archive test in `tests/draft/archive.test.ts`: on completion the archive holds every pick, the keepers, the order, the teams and the owner's team; it survives a later league re-sync **and** disconnecting the league (the account-keyed tables must outlive the cascade); `observed_at` is first-seen-wins after a rebuild; and after `draft_complete` the alarm is gone and a subsequent `ensureRunning()` leaves it gone while still completing the archive (FR-005/FR-008 — the only evidence anywhere for US1 AS5)
- [ ] T055 Implement `src/draft/archive.ts`: on completion write `draft_archives` + `draft_picks` + `draft_keepers` in one `db.batch()` chunked at **10 rows per statement** (D1's 100-bound-parameter cap), **copying** `my_team_id`, `order_json` and `teams_json` into `draft_archives` (because `league_snapshots` is overwritten on every re-sync and `draft_sessions` cascades away with the connection — neither can hold them), and use `ON CONFLICT DO UPDATE` that never overwrites `observed_at` (depends on T021)
- [ ] T056 Wire archive retry into `ensureRunning()` in `src/draft/session.ts` so a session with `completed_at IS NOT NULL AND archived_at IS NULL` finishes archiving on the next cron tick — **without arming a poll alarm** (depends on T055)
- [ ] T057 Call the `shutdown()` RPC from `deleteConnection` in `src/db/leagues.ts`: re-adding a league mints a new connection UUID and therefore a new DO, and an orphaned session would keep polling ESPN forever with no D1 row behind it — a read-only leak against Constitution VI and a cost leak. The account-keyed archive is deliberately **not** deleted. **`shutdown()` MUST flush a pending archive first**: between completion and the next cron tick the picks live only in the DO blob, so a disconnect in that window would `deleteAll()` the only copy while cascading away the `draft_sessions` retry row — losing a completed draft FR-013 says is kept forever. Archive-then-shutdown, and assert the ordering in T054 (depends on T025, T055)
- [ ] T058 [P] Credential-sweep test in `tests/draft/no-secrets.test.ts` (FR-024a, mirroring 001's SC-005 grep test): dump the DO storage blob and every D1 draft row and assert neither contains the `espn_s2` or `SWID` values; assert credentials are read per request rather than memoized. **Re-assert T006's fixture gate in CI** by running the same Node-side script from an npm script — not from inside this Workers-pool test, which has no filesystem access (001's `tests/contract/no-secrets.test.ts` statically imports its one fixture for the same reason)
- [ ] T059 [P] Isolation test in `tests/draft/isolation.test.ts` (FR-018): a second account gets 404 on every draft route for a league it does not own, **including the WebSocket upgrade**
- [ ] T060 [P] Multi-client test in `tests/draft/multi-client.test.ts` (FR-017): two sockets receive identical frames with identical `seq`; killing one leaves the other unaffected; after the T011 dependency bump, `evictDurableObject(stub, { webSockets: "close" })` confirms hibernate-across-eviction
- [ ] T061 [P] Concurrent-drafts test in `tests/draft/concurrent.test.ts` (SC-009): two connections belonging to the same account drafting simultaneously each maintain complete, correct state with no cross-contamination of picks or events — distinct from T059 (second account) and T060 (two sockets, one session)

---

## Phase 9: Polish & Cross-Cutting

- [ ] T062 Add a comment in `src/api/app.ts` recording the standing constraint that **no middleware may mutate the proxied 101 response** — `c.res.headers.set(...)` after `await next()` throws `Can't modify immutable headers` and 500s the upgrade, so a future request-id or CORS decorator would silently kill the draft stream
- [ ] T063 [P] Record the draft-day operational notes for 009 in `specs/005-draft-monitor/quickstart.md`: deploy the DO migration well before draft day (migrations cannot be gradually deployed), no deploys during a draft (a new version restarts every DO and drops every WebSocket), and alarm timing is best-effort with documented delays up to a minute
- [ ] T064 Full sweep: `npm test` (both projects), both tsc configs, eslint, build — all clean; then run every quickstart.md scenario against `wrangler dev`
- [ ] T065 Live validation (SC-011): watch a real ESPN draft through the diagnostic page end to end, confirming every pick, the clock and at least one reconnect by eye against ESPN's own draft room, and record the result in `specs/005-draft-monitor/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Gate 0 (Phase 1)**: no dependencies — **blocks everything**, including Setup. A failed gate ends the feature until `/speckit-clarify` resolves the transport question.
- **Setup (Phase 2)**: after Gate 0 passes.
- **Foundational (Phase 3)**: after Setup — blocks all user stories.
- **US1 (Phase 4)**: after Foundational. No dependency on other stories.
- **US2 (Phase 5)**: after US1 — extends the DO and the socket US1 creates.
- **US3 (Phase 6)**: after US1, **not merely after Foundational** — T044/T046/T047 all edit `src/draft/session.ts`, which US1 creates. US3 and US2 are independently *testable* but **not file-disjoint**; run them sequentially, or expect merge conflicts in that one file.
- **US4 (Phase 7)**: after Foundational — the reducer already emits events; this phase finalizes and proves the contract. Genuinely independent of US2/US3 (touches `reconcile.ts` and tests).
- **Retention (Phase 8)**: after US1 (needs the DO), Foundational (needs `src/db/draft.ts`) and US3 (T056 extends T044's `ensureRunning`).
- **Polish (Phase 9)**: last.

### Within Each User Story

Tests are written and failing before implementation. Pure modules before the DO;
the DO before the API; the API before the web client.

### Parallel Opportunities

- **Phase 2**: T008–T011 are four different files — fully parallel after T007.
- **Phase 3**: the three pure modules are independent — T015/T016 (cadence),
  T017/T018 (snake) and T012/T013 (ESPN types) all run in parallel; only
  T014 and T020 serialize behind them.
- **Phase 4**: T022–T024 in parallel; T032 in parallel with the DO work.
- **Phase 5**: all four tests (T034–T037) in parallel.
- **Phase 7**: all three tests (T048–T050) in parallel, and the whole phase in
  parallel with US2/US3.
- **Phase 8**: T054, T058, T059, T060, T061 in parallel.
- **Across stories**: US4 can proceed alongside US2 and US3. US2 and US3 cannot
  run concurrently — both rewrite `src/draft/session.ts`.

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
work. And do not skip T001's sanitization: a raw capture committed once lives in
git history permanently.

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
