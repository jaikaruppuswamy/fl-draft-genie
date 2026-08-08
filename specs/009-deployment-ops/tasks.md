# Tasks: Deployment Ops

**Feature**: 009-deployment-ops | **Branch**: `019-009-spec-refresh` | **Date**: 2026-08-08

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/alerts.md](contracts/alerts.md),
[contracts/checks.md](contracts/checks.md), [quickstart.md](quickstart.md)

## Format: `[ID] [P?] [Story] Description`

- **[P]** — parallelisable: different file, no dependency on incomplete work
- **[US1]…[US4]** — the user story this serves. Setup, Foundational and Polish
  carry no story label

## Path Conventions

Worker source in `src/`, userscript in `tap/`, web app in `web/src/`, migrations
in `migrations/`, docs in `docs/`, tests in `tests/`.

**The database is `draft-genie`. Never write its id into any file under
`tests/fixtures`, `tests/tap`, `tests/contract`, `tap`, `src`, `web/src` or
`specs` — those are swept, and the sweep cannot tell a database id from a SWID.**

---

## The decision every task inherits

**Derive alerts from state the system already writes, and add exactly one table —
a counter.**

The data is already there: freshness timestamps, heartbeats, sync outcomes. What
is missing is *memory between ticks*. `stage()` catches every throw and returns
void, so "has this failed repeatedly" (FR-002) and "have I already said so"
(FR-006) have nowhere to live.

Everything follows from that. No metrics pipeline, no Logpush, no per-tick
history, no second environment. **Nothing on the draft-day request path** —
SC-009 requires draft-day behaviour and latency unchanged, so every evaluation
happens on a scheduled run.

## Prerequisites already satisfied

- The `EMAIL` binding, a verified sending domain, and `createEmailSender(env)`
  exist and are used for sign-in.
- `observability.enabled` is true.
- `src/draft/liveness.ts` already holds pure, tested predicates.
- `league_connections.last_sync_at` / `last_sync_status` are already written.
- `npm test` already rebuilds the userscript first (018), so bundle-asserting
  tests cannot pass against a stale artifact.

---

## Phase 1: Setup — gates first

**Both gates are constitution MUSTs**: *"a feature whose premise rests on an
unverified external behavior MUST verify it first, in the cheapest possible
experiment."* 005 and 008 both had their shape changed by one. Do not start
Phase 3 before T001 answers.

- [ ] T001 **GATE — can the Worker actually email the operator?** Send one message through the existing `EMAIL` binding to the intended alert address, from a scratch route or a local `wrangler dev` invocation, and record the result in this file. **User Story 1 rests entirely on this.** Cloudflare's `send_email` binding may only deliver to addresses verified as Email Routing destinations, and `neelamjai.com` is currently a *sending* domain — being able to send sign-in mail does **not** establish that an arbitrary operator address can receive. **If it cannot**: US1's channel assumption collapses and the spec's Assumptions must be reopened before any alerting code is written — do not build a notifier that cannot notify
- [ ] T002 **GATE — which Workers plan is this account on?** Record it in this file. It resolves two open questions at once: log retention (**3 days on Free, 7 on Paid** — the deferred FR-007 decision) and D1 Time Travel retention (**7 days on Free, 30 on Paid** — FR-020's second bound). Note that an out-of-window Time Travel request returns a bare `internal error [code: 7500]`, so probing cannot distinguish "wrong plan" from "wrong timestamp" — read the plan directly rather than inferring it
- [ ] T003 [P] Fix the privacy sweep's own FR-011 violation in `scripts/privacy-sweep.ts`: the GUID branch pushes `non-placeholder GUID ${g.slice(0, 8)}…`, putting **32 bits of a real SWID** into what is about to become a public CI log. Report the file and a count only, exactly as the member-name branch already does. **This must land before the sweep becomes a merge gate** — turning on a leak-detector that leaks is this feature failing at its own thesis
- [ ] T004 [P] Widen the `espn_s2` check in `scripts/privacy-sweep.ts`: the regex requires an *unquoted* key followed by a quoted value, so JSON `"espn_s2": "AEB…"` — the shape every captured ESPN fixture uses — and a raw cookie string both pass today. Add a test planting each shape that PROVES the check can fail
- [ ] T005 [P] Make `npm test` work on a pristine clone. `wrangler.jsonc` declares `assets.directory: "web/dist"`, `web/dist` is gitignored, and the pool validates it while loading the config — so a fresh `git clone && npm ci && npm test` fails with a message about a missing directory. Fix at the source (a `pretest` step, or `mkdir -p web/dist` inside `build:tap`) so a new contributor is not the one who discovers it
- [ ] T006 [P] Add the third project to `npm run typecheck` in `package.json`: `tsc -p web/tsconfig.json --noEmit`. FR-009 says *all* type-check projects and the script currently runs two. Verified to exit 0 today, so this is free

---

## Phase 2: Foundational (blocking prerequisites)

- [ ] T007 Create `migrations/0014_ops.sql` with the `ops_conditions` table per [data-model.md](data-model.md): `key` PK, `kind`, `scope`, `last_ok_at`, `last_failed_at`, `consecutive`, `last_error_code`, `last_notified_at`, `notify_count`, `resolved_at`, `updated_at`, plus an index on `kind`. Header comment must state why the table exists (a counter that survives the tick) and why `scope` never holds a `connection_id`
- [ ] T008 Implement `src/ops/state.ts`: read a condition, record an observation, and answer *should this notify now?* Encode FR-002 (two observations), FR-006 (bounded repetition with backoff) and recurrence-after-resolve in **one place**, so no caller can implement half of it. Model it on `league_snapshots.espn_reset_suspected_at`, which is already this shape
- [ ] T009 Write the state-machine tests in `tests/unit/ops-state.test.ts` **before** wiring anything: first observation does NOT notify; second does; a healthy observation clears; a resolved-then-recurring condition may notify again; repetition is bounded. Include a companion assertion that PROVES the "does not notify" case can fail, so a broken gate cannot pass silently
- [ ] T010 Change `stage()` in `src/sync/predraft.ts` to return `{ ok, code?, produced? }` instead of void, and record each stage's outcome via T008. **`produced` is load-bearing and separate from `ok`** — FR-004 is about a job that ran cleanly and produced nothing, which "no error" cannot express. Keep `stage()` swallowing throws so one failing stage cannot cancel the rest
- [ ] T011 Fix `src/index.ts` to await (or otherwise surface) `runScheduledMaintenance` rather than dropping it into a bare `ctx.waitUntil`. Today a failing tick is reported to the platform as **success**, so the free Cron Events signal lies — and the ops write can be torn down before it lands. Cheaper than any table, and it raises the value of a signal that already exists
- [ ] T012 [P] Store `last_error_code` as a **bounded code**, never an exception message — add the closed union in `src/ops/state.ts` and reject anything else at the type level. `redact()` strips braced SWIDs, `espn_s2` assignments and long blobs but **not bare UUIDs**, and `scripts/privacy-sweep.ts` walks files so it can never inspect a D1 row. A free-text column here is an unwatched privacy surface that grows on a schedule

---

## Phase 3: User Story 1 — Tell me when something has quietly stopped working (P1) 🎯 MVP

**Goal**: the owner learns that something broke from a message, not from reading
code or the database.

**Independent test**: cause a scheduled run to fail and confirm a notification
arrives naming what failed, without anyone inspecting logs or the database.

**Blocked by T001.** Do not start until the email gate has answered.

- [ ] T013 [US1] Write the FR-003 predicate tests FIRST in `tests/unit/ops-conditions.test.ts`, including the three cases that must be distinguished: the tap died, picks stopped, the server stopped. **The middle one is the whole point** — assert explicitly that a session with a fresh heartbeat and no picks for 5 minutes DOES alert
- [ ] T014 [US1] Implement the live-draft gate in `src/ops/conditions.ts` as `completed_at IS NULL AND armed_at IS NOT NULL AND last_heartbeat_at IS NOT NULL`. **Do NOT use `isLiveDraft()`** — it thresholds on `status IN ('armed','live','not_receiving','degraded')`, and `not_receiving`/`degraded` are **never written** by anything while `idle`, which the list excludes, is the current production state of both tap-attached sessions
- [ ] T015 [US1] Implement the tap-side predicate using `heartbeatLapsed()` against `draft_sessions.last_heartbeat_at` + `heartbeat_hidden`. Document at the call site that this means **"the tap process died"** and nothing more
- [ ] T016 [US1] Implement the picks-stalled predicate (FR-003a): during a live draft, `MAX(tap_batches.received_at)` for `(espn_league_id, season)` not advancing for **5 minutes**. **This is the predicate that catches the 2026-08-06/07 freeze**, which a heartbeat-only design misses entirely — `recordRelayActivity` refreshes the heartbeat on every accepted batch, so a tap relaying nothing looks healthy. FR-003b forbids tightening below the 90 s+ human pick cadence 005 measured
- [ ] T017 [US1] Implement the server-side predicate as a **divergence**: unconsumed batches beyond the session's consumed point while the heartbeat is fresh. Poll `snapshot().revision` from the scheduled sweep and store it via T008. **Do NOT revive `saveCursor()`** — it has zero callers, and calling it from the pump lands a D1 write inside the Durable Object's `blockConcurrencyWhile` gate that draft-room snapshot reads contend for (SC-009)
- [ ] T018 [US1] Query `draft_sessions` for the league **directly and unfiltered** in the alerter. Do NOT call `latestLeagueHeartbeat()` — it applies a per-viewer entitlement filter that collapses to same-account-only for a `manual` connection, which would silently blind the operator. Its real merit (surviving relayer handover) is worth keeping in the product path, not here
- [ ] T019 [US1] Add a second `* * * * *` trigger in `wrangler.jsonc` and dispatch on `controller.cron` in `src/index.ts`, so the 1-minute tick runs **only** the live-draft checks and short-circuits when no draft is armed (FR-003c). Without it SC-002 is arithmetically unreachable: a 150 s lapse threshold on a 300 s grid is 7.5 minutes before anything looks
- [ ] T020 [P] [US1] Implement the archive-silence predicate (FR-004) as a **disagreement check**: for a league whose draft date has passed, assert a `draft_archives` row exists for `(espn_league_id, season)`. **Do NOT use `sessionsAwaitingArchive()` age** — it requires `completed_at IS NOT NULL`, which is never set when `totalPicks = 0` (every production draft so far), and it goes permanently red for `no_picks`/`connection_gone`, which teaches the owner to ignore it
- [ ] T021 [P] [US1] Implement the projections-freshness predicate against `getServingSet(season).fetched_at` + `isStale()` — 24 h in Aug/Sep, 7 d otherwise
- [ ] T022 [P] [US1] Implement the signals-freshness predicate against `MAX(signal_entries.computed_at)`, **independent of projections**. `computeSignals` runs only when projections refreshed or the table is empty, so a signals failure after a successful ingest is never retried and never co-fires — dedupe by `(condition, scope)`, never by presumed common cause
- [ ] T023 [US1] Implement alert rendering in `src/ops/alert.ts` from the **closed vocabulary** in [contracts/alerts.md](contracts/alerts.md) §1. Every alert carries a remedy (FR-015) — a bare condition name is a spec violation by the same argument Principle VII makes about recommendations
- [ ] T024 [US1] Implement the outbound screen and assert it **immediately before send**, over subject *and* body: no GUID shape, no `https?://`, no `@`. Failing the screen **drops the alert and logs the condition key only** — never send a partially redacted message, or a redaction bug becomes a delivery path
- [ ] T025 [US1] Write the adversarial screen tests in `tests/contract/ops-alert.test.ts`: reject a body containing a UUID, an `@`, and a URL; reject them in the subject too. Include the companion assertion that PROVES the screen can fail
- [ ] T026 [US1] Read the destination from an **`ALERT_TO` secret**, never a `destination_address` in `wrangler.jsonc` — that file is committed to a **public** repo and would publish the operator's address. Missing `ALERT_TO` or `EMAIL` must **throw loudly**, matching `cloudflareSender`; a silent no-op alerter is the failure mode this whole feature exists to end
- [ ] T027 [US1] Put alert sending in `src/ops/alert.ts` and **do not add a method to `EmailSender`**. Reuse the channel through the existing provider factory so the sign-in contract stays untouched
- [ ] T028 [US1] Wire the scan into the 5-minute run as its final step, and **do not wrap it in `stage()`**. `stage()` swallows every throw; the alerter is the one failure that must reach `scheduled()` and land in Cron Trigger Past Events
- [ ] T029 [US1] Scope every alert by `espn_league_id` + `season` (FR-008), under the operator exemption ratified into the constitution as **1.2.0**. Assert in tests that `connection_id`, `account_id`, any other UUID, and `league_snapshots.league_name` never appear (FR-008b)
- [ ] T030 [US1] Exempt the two live-draft conditions from the two-observation gate — their thresholds already carry the debounce (150 s = three missed beats; 5 min ≈ three missed pick slots) and doubling them doubles detection time on the draft-day path
- [ ] T031 [US1] Run the quickstart US1 scenarios end to end, **especially scenario 4's second half** — tap heartbeating and relaying while the session stops consuming. If only one thing is verified by hand, verify that one: it is the failure that started this feature

---

## Phase 4: User Story 2 — Stop me shipping something broken (P2)

**Goal**: a change that breaks a test, or that would put a name or a secret into
a public repository, fails before it lands.

**Independent test**: open a change that breaks a test and one that adds a
forbidden identifier to a fixture; confirm both are rejected automatically.

**Blocked by T003–T006.** The gate must be safe before it is switched on.

- [ ] T032 [US2] Create `.github/workflows/ci.yml` per [contracts/checks.md](contracts/checks.md): one job, **zero secrets**, `on: push` (no branch filter) + `on: pull_request`, `permissions: contents: read`, Node pinned inline to `22`. Steps: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, then `git diff --exit-code web/public/draft-tap.user.js`
- [ ] T033 [US2] Use `pull_request`, **never `pull_request_target`** — the latter hands full secrets and a read/write token to a run whose checkout the contributor controls. Add no `secrets:` block and no third-party actions; deploy stays out of this workflow entirely
- [ ] T034 [US2] Do **not** add a `concurrency` block with `cancel-in-progress`. A cancelled run is a commit with no pass/fail, which is exactly what SC-004 forbids
- [ ] T035 [US2] Enable branch protection on `main` requiring the single `check` job, plus **"require branches to be up to date"** (US2 AS-4 — a green tick on stale results is worse than none) and **"do not allow bypassing"** (without it FR-010 is advisory). Manual step; record the date here
- [ ] T036 [US2] Add a regression test asserting no file under a swept root contains a bare UUID that would trip the sweep — the mechanism by which **009's own runbook would fail the gate 009 adds**. Refer to the database as `draft-genie` everywhere, never by id
- [ ] T037 [US2] Verify FR-013 by running the whole chain on a pristine checkout with `.dev.vars` deleted, `HOME` pointed at an empty directory, and no `CLOUDFLARE_*` variables. It passes today; the test is that it *keeps* passing

---

## Phase 5: User Story 3 — Tell me what to do, on the day (P3)

**Goal**: ten minutes before the draft, one document says what to check, in
order, and what each symptom means.

**Independent test**: someone who has not read the code diagnoses a withheld
recommendation and a dead tap from the symptoms alone.

- [ ] T038 [US3] Create `docs/runbook.md` covering FR-014's minimum: pre-draft verification and its deadline; no recommendations appearing; the tap not delivering; reachability failure; and what to capture when something is not covered
- [ ] T039 [US3] Write the limitations section **scoped correctly** (FR-016): **relaying** needs a desktop browser with a userscript manager; **watching** is an ordinary web page and works anywhere, including an iPad
- [ ] T040 [US3] Record FR-016a explicitly, with the reason: a limitation must be **demonstrated** before it is written down. The spec previously asked for "no live monitoring from an iPad", which the 2026-08-06/07 drafts disproved — desktop Chrome froze identically and the cause was a defect, since fixed. A runbook asserting it would have sent the owner away from a device that works
- [ ] T041 [P] [US3] Document that **the draft-room tab *is* the tap** — the single most confusing point during both live drafts
- [ ] T042 [P] [US3] Document the **break-glass**: Principle V requires a way to land a fix mid-draft. State that the local `npm run deploy` path needs no CI and is the real answer in most cases, who may lift branch protection, and the requirement to restore it and open a reconstructing PR afterwards
- [ ] T043 [P] [US3] Document the **known gap**: if the scheduled run stops entirely, no alert can fire, because the detector and the notifier both run on it. Name Cron Trigger Past Events as the manual check. Stating this is the point — an unstated gap is indistinguishable from a covered one
- [ ] T044 [P] [US3] Document the secret-rotation procedure per [research.md](research.md) §5, in this order: advance notice → `DELETE FROM espn_credentials` → `wrangler secret put` → wait for propagation → tell owners to re-paste → verify via `league_connections.last_sync_status`. **Order is load-bearing**: notifying first invites a paste that lands between the delete and the new key, encrypted under the dying key. Note that the app will **not** prompt anyone — both banners key on `failing`, not absent — so the out-of-band message is load-bearing, not a courtesy
- [ ] T045 [US3] Hand the runbook to someone who has not read the source and have them diagnose the two most likely failures (SC-007). Record the outcome here. If they cannot, the runbook has failed its only test

---

## Phase 6: User Story 4 — Let me get the data back (P4)

**Goal**: recovery is a capability that has been exercised, not a belief.

**Independent test**: restore to a point in time in a scratch location and
confirm the expected rows are present.

- [ ] T046 [US4] Run the recovery drill per [quickstart.md](quickstart.md) and record the date. **Time Travel cannot restore into a scratch database** — it only overwrites in place — so the drill is export → new database → restore *there*. Export only `pro_teams`, `players`, `projection_sets`, `player_projections`, `signal_entries`: foreign-key closed, and carrying **no account ids, no league ids, no league names**
- [ ] T047 [US4] Record FR-019 honestly as **"production is never written and never restored"**, not "untouched" — a running export blocks other database requests. Require the drill to run outside any pre-draft window
- [ ] T048 [US4] Record FR-020 as **two bounds**: earliest restorable point is `max(database creation, now − retention)`, with retention from T002. Note that an out-of-window request returns a bare `internal error [code: 7500]`, so a failure is not self-explanatory
- [ ] T049 [US4] Document that **`rebuild()` is mandatory after any restore**, alongside `wrangler d1 migrations apply` — the Durable Object cursor is not restored with D1, and a surviving cursor makes a restored tap log invisible
- [ ] T050 [US4] Document the cross-runbook hazard in **both** the recovery and rotation procedures: after a `CREDENTIAL_KEY` rotation, restoring to a point before it strands every credential under a key that no longer exists, and must be followed by a purge and re-paste. The person restoring months later will not be reading the rotation runbook
- [ ] T051 [US4] Remove the prior-season DELETE from `pruneSets()` in `src/db/projections.ts` (FR-021), keeping the stale-`building` sweep. ~16 MB/season measured
- [ ] T052 [US4] Add a **dated superseding note** to 002's FR-018 and correct the overstatement in `migrations/0008_draft.sql`'s comment. **Do NOT edit 002's Clarifications log** — rewriting a ratified answer would falsify the record of what was decided. Record the decision in `ROADMAP.md` per CLAUDE.md
- [ ] T053 [P] [US4] Sweep the **other** destructive rules and record each as intended or corrected (FR-021): `deleteConnection` cascading `preferred_players`, `deleteAccount` cascading the whole irreplaceable set, the `signal_entries` per-kind delete, and the already-executed `DROP TABLE tier_entries`
- [ ] T054 [US4] Add a `database_size` threshold check to the scheduled run. Removing the prior-season prune removes the only bound on growth, and discovering the ceiling on draft day is precisely the failure this feature exists to prevent

---

## Phase 7: Polish & Cross-Cutting

- [ ] T055 [P] Record in `ROADMAP.md` that 009 is complete, with the constitution amendment (1.2.0) and the FR-021 retention decision noted
- [ ] T056 [P] Confirm SC-009 by comparison, not assertion: draft-day latency unchanged. Every evaluation is on a scheduled run, but say so against a measurement
- [ ] T057 Re-run the full suite, both typecheck projects, lint, the web build and the privacy sweep. Report **counts**, not just pass/fail
- [ ] T058 Deploy, then verify the live artifact rather than the deploy log — assets are edge-cached and a fetch immediately after deploy can return the previous version

---

## Dependencies

```text
Phase 1 (T001–T006)  ─┬─> T001 GATES Phase 3 (US1) entirely
                      ├─> T002 resolves FR-007 + FR-020
                      └─> T003–T006 GATE Phase 4 (US2)

Phase 2 (T007–T012)  ─────> required by Phase 3 (US1)

Phase 3 (US1) ── independent of US2, US3, US4
Phase 4 (US2) ── needs T003–T006 only
Phase 5 (US3) ── independent; T044 reads research §5
Phase 6 (US4) ── T048 needs T002; otherwise independent
```

**No user story depends on another.** US1 is the only one needing Phase 2.

## Parallel opportunities

- **T003, T004, T005, T006** — four different concerns, four different files
- **T020, T021, T022** — three independent predicates
- **T041, T042, T043, T044** — four independent runbook sections
- **T053, T055, T056** — independent

## Implementation strategy

**MVP is US1** (Phase 1 → 2 → 3). It is the failure mode this project actually
has: five of six historical defects were silent, and the two worst were found by
the owner mid-draft.

**But if time is short, do Phase 1 → US2 → US3 instead.** CI and a runbook are
most of the value at a fraction of the work, and a runbook helps on a day when
code changes cannot. Alerting is the part that needs care — an alert that cries
wolf is worse than none, which is why T016's threshold was ratified against
measured data rather than chosen.

**Phase 1 is not optional and comes first in every ordering.**

## The six traps in this feature

1. **The heartbeat trap.** A lapsed heartbeat means *the tap process died*, not
   *picks stopped*. `recordRelayActivity` refreshes it on every accepted batch,
   so a tap relaying nothing looks perfectly healthy — and that is exactly the
   2026-08-06/07 freeze. T016 exists because of this.
2. **The status trap.** `not_receiving` and `degraded` are declared in the
   schema, in `SessionStatus`, and in this spec's own Dependencies list — and
   **nothing ever writes them**. Any threshold on `draft_sessions.status` tests
   for values that cannot occur. T014.
3. **The leaking leak-detector.** The privacy sweep prints 32 bits of a real
   SWID. Turning it on as a public-CI gate before T003 would ship a privacy
   regression in the name of preventing one.
4. **The gate that blocks its own documentation.** `specs/` is swept and a D1
   database id is indistinguishable from a SWID, so 009's runbook can fail the
   check 009 adds. Name the database, never its id. T036.
5. **The permanently-red signal.** `sessionsAwaitingArchive()` never clears for
   `no_picks`/`connection_gone`, and never fires for a draft that never
   completed. A signal that is always on conveys as little as one that is never
   on. T020.
6. **The alerter that cannot report its own death.** If the scheduled run stops,
   the detector and the notifier both stop with it. This is not solved — it is
   **written down** (T043), which is the honest treatment of a gap that would
   cost more to close than it is worth for one operator.
