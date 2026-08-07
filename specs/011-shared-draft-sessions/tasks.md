---

description: "Task list for 011-shared-draft-sessions"
---

# Tasks: Shared Draft Sessions (011)

**Input**: Design documents from `specs/011-shared-draft-sessions/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/delivery.md](contracts/delivery.md), [contracts/enablement.md](contracts/enablement.md), [quickstart.md](quickstart.md)

**Tests**: requested, and unavoidable. This feature changes **shipped behaviour
in five places** (005, 007, 008, 010, the tap) and every defect it fixes was
found in live use rather than by a test — which is the argument for writing them
now. The pure pieces get their tests first, as `reconcile.ts`, `recommend.ts`,
`draftRoom.ts` and `replay.ts` all did.

**Mutation testing is the acceptance bar**, not line coverage. 008's sweep found
a survivor that turned out to be a real defect; the one here most worth
attacking is the ledger admission rule, because a version that rejects
everything and a version that rejects nothing both pass a careless test.

**No new tables, no schema change, no re-key.** If a task seems to need one,
stop — that is the signal that fan-out has been abandoned for the re-key
research §1 rejected.

## Format: `[ID] [P?] [Story] Description`

- **[P]** — parallelisable: a **different file** from every other task that could
  run alongside it, and no dependency on an incomplete task
- **[US1]…[US8]** — the user story a task serves; absent for Setup, Foundational
  and Polish. **US8 was added after the rest**, so its task ids (T059+) sit above
  US6's and US7's while its priority (P6) sits below theirs — ids are
  identifiers, the dependency graph is the order

## Path Conventions

Worker + Durable Object (`src/`), React SPA (`web/src/`), userscript (`tap/`),
lab scripts (`scripts/`). Tests split by runtime:

| Suite | Runtime | Why |
|---|---|---|
| `tests/draft/**` | workers pool, `isolatedStorage: false` | Durable Object + WebSockets |
| `tests/tap/**`, `tests/room/**`, `tests/lab/**` | node | pure modules and browser-targeted code |

A test that needs the Durable Object goes in `tests/draft/`. Putting it elsewhere
is how it silently never runs.

## The decision every task inherits

> **FAN OUT, DO NOT RE-KEY.** The session stays addressed
> `connectionId:season`. Ingest arms and nudges **every** connected manager's
> session for the league, and each object reconciles the same frames against its
> own scope.

That is what makes FR-002 (own perspective) and FR-005 (own settings) hold by
construction. Re-keying to `leagueId:season` would additionally require lifting
perspective out of the object and reapplying it per viewer — inventing exactly
the layer whose absence is being fixed.

## Prerequisites already satisfied

Do **not** rebuild these. Each was verified during planning.

- **Frames already converge.** `foldBatches()` unions ledger and incremental
  picks; `reconcile()` merges on pick identity. Two relays are the same problem
  with a wider source set, not a new one.
- **`tap_batches` already carries `account_id`.** US7 is a change of column, not
  a schema change.
- **`tap_pairings` already cascades from `accounts` only** — no `connection_id`
  column at all. A league disconnect never touched it; the 2026-08-06 diagnosis
  that said otherwise was wrong.
- **`tap/draftEnd.ts` already detects draft end** (010 T045). US4's second
  signal builds on it rather than inventing detection.
- **The tap is already strictly passive** and `tests/tap/passivity.test.ts`
  asserts it against the shipped artifact. Keep it passing; do not re-derive it.

---

## Phase 1: Setup

- [X] T001 **GATE — does ESPN's completion flag flip back?** Reset a completed draft in ESPN, sync, and record in this file whether `draftDetail.drafted` returns to **false**. **US8 rests entirely on it** and nobody has checked; what *is* verified is only that mocks never appear in ESPN's league record at all, which is a different fact. **This is a constitution MUST** (an unverified external premise is verified first, in the cheapest possible experiment) and it is the third time this project has needed it — 005 Gate 0 and 008 Gate 0 both changed a feature's shape. **If the flag does not flip**: Phase 8 has no signal, US8 collapses, and US5 becomes the only reset path — record that here and in [spec.md](spec.md) rather than building against a signal that never arrives
  - **How to run it**: `scripts/gate-draft-reset.ts` (`npm run gate:reset -- --league <id>`), against `DraftGenieTester`, whose draft is complete in the **current** season. Two runs of the same command with a real reset in between: run 1 records the baseline, run 2 compares and prints the verdict. The premise is a *transition* — `drafted: true` becoming `false` for one league and season — so a past-season read (008's `lab:gate0` shape) cannot answer it: that measures persistence, not reversal.
  - **What it measures beyond the flag**: three reads per run, because FR-031f says an ambiguous report voids nothing and one read cannot tell a flip from an odd response; the pick record alongside the flag, so a sticky flag with an emptied draft is reported as a *different* signal rather than as a failure; and `drafted` as **three** states — true, false and **absent** — because production parses `draftDetail?.drafted ?? false`, which would turn a missing field into a reset ESPN never reported. All five outcomes were rehearsed against a stub before the gate was run for real.
  - **RESULT — GATE PASSES, measured 2026-08-07**, league `1064865483` (2026, `DraftGenieTester`, 6 teams, SNAKE, 72 picks), 3 reads per run, all three in agreement. **`draftDetail.drafted` returned to `false`.** US8's premise holds: Phase 8 has its signal and T049/T050 can key on ESPN's own report.
    - **The pick record corroborates**: 72 filled picks → 0, and the skeleton returned in their place (0 → 72 rows at `playerId: -1`). `pickRows` stayed 72 throughout, so a reset **rebuilds the skeleton** rather than emptying the array — counting rows would have seen no change at all. Detection must look at pick *contents*, never at `picks.length`.
    - **`drafted` was PRESENT and `false`, never absent**, so the `?? false` coercion hazard did not fire here. That is one observation of one reset, not a guarantee; T050 should still require the field to be present before treating `false` as a signal (FR-031f).
    - **A reset also CLEARS ESPN's draft date** — `settings.draftSettings.date` went from `2026-08-06T06:15:00.000Z` to absent. Unmeasured before this run, and it has consequences for T050/T055 recorded under Phase 8.
- [X] T002 Add a league-scoped connection lookup to `src/db/leagues.ts` — every connection for one `(espn_league_id, season)`, across accounts — since fan-out needs the audience before it can deliver to it
- [X] T003 [P] Measure and record here (not in [research.md](research.md), which is the Phase 0 record and must not be rewritten mid-build) the current delivery latency for the relaying manager, so SC-001's "unchanged" is a comparison rather than an assertion
  - **Baseline recorded 2026-08-06**: the only measured figure this project has is 005's — **p95 0.223 s across a 72-pick draft**, against a ratified budget of p95 ≤ 2 s / 100% ≤ 10 s. A *fresh* pre-change measurement needs a live draft, which is not available on demand; 005's figure is therefore the comparison point, and T067 must re-measure under the same conditions (a real draft) rather than a synthetic one, or the comparison is between different things.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the vocabulary every story needs. **No user story starts until this
phase is done.**

- [X] T004 Split `SessionScope` in `src/draft/session.ts` into its shared half (`espnLeagueId`, `season`, `order`) and per-manager half (`accountId`, `connectionId`, `myTeamId`, `totalPicks`) per [data-model.md](data-model.md) — types only, no behaviour change yet, so the compiler finds every site that conflates them
- [X] T005 Write the scope-split guard in `tests/draft/scope.test.ts`: a session's per-manager fields MUST come from its own connection and never from a relaying account. **`totalPicks` is per-manager** — two managers recorded 11 and 12 rounds for the same draft on 2026-08-06
- [X] T006 [P] Define the three draft-room states and four tap states in one place per [data-model.md](data-model.md) §4, each carrying a remedy, so the two surfaces cannot drift into different vocabularies

**Checkpoint**: `npm test` green; the conflation sites are visible in the type
errors T004 produces.

---

## Phase 3: User Story 1 — See the draft when a leaguemate is relaying (P1) 🎯 MVP

**Goal**: a manager with no tap sees the draft, from their own perspective.

**Independent test**: with one manager relaying and a second not, open the second
manager's draft room and confirm picks arrive with **their** team highlighted.

- [X] T007 [US1] Write fan-out tests FIRST in `tests/draft/fanout.test.ts`: a frame for a league arms **every** connected manager's session; each builds state from its own scope; a non-member receives nothing (FR-001, FR-004)
- [X] T008 [US1] Make arming league-wide in `src/api/tap.ts` — arm every connection returned by T002, each with its own scope. **Sessions currently arm from their own tap's first frame, so a manager with no tap has no session at all**; this is the change that gives them one
- [X] T009 [US1] Nudge every armed session for the league in `src/api/tap.ts`, keeping the existing after-response scheduling so a Durable Object round trip never sits on the tap's request path
- [X] T010 [P] [US1] Assert in `tests/draft/fanout.test.ts` that a delivered payload contains **no relayer identity** — account, connection, install or session id (FR-003, SC-003) — **and that every delivered view carries the viewing manager's own team, never the relayer's** (FR-002, SC-002)
- [X] T011 [US1] Surface a settings disagreement rather than resolving it, in `src/draft/session.ts`: each session uses its own `totalPicks`, and a mismatch across managers is reported (FR-005)
- [X] T012 [US1] Report "no active relay" and its remedy in `web/src/pages/DraftRoom.tsx` (FR-006)
- [X] T013 [US1] Report a relay that **stopped mid-draft** with the same message for every manager, naming what would restore it, and never presentable as a draft that has not started (FR-006a)
- [X] T014 [US1] Accept several relays and converge on pick identity in `src/draft/feed.ts` (FR-007a)
- [X] T015 [US1] Prefer the frame carrying **more information** over the one that arrived first (FR-007b). `foldBatches` already prefers ledger coverage over arrival order for exactly this reason — a tap flushing after an outage sends an old snapshot with a new timestamp
- [X] T016 [US1] Measure delivery latency for a non-relaying manager against T003's baseline and confirm 005's budget holds (FR-007, SC-001)

**Checkpoint**: a manager on an iPad sees the draft.

---

## Phase 4: User Story 2 — Tell the truth about what is working (P2)

**Goal**: neither surface ever mistakes one failure for another.

**Independent test**: force each surface into each state and confirm every one is
reported distinctly, with a remedy.

- [X] T017 [US2] Write state tests FIRST in `tests/room/state.test.ts`: **no session armed ⇒ waiting for the draft, NOT a reachability failure** — the false alarm that fired seven minutes before a draft on 2026-08-05
- [X] T018 [US2] Distinguish waiting / cannot-reach / reachable-but-not-receiving in `web/src/pages/DraftRoom.tsx`, each with its remedy (FR-011, FR-012, FR-013)
- [X] T019 [US2] Keep a transient reconnection from presenting as failure while it is still expected to succeed (FR-014)
- [X] T020 [P] [US2] Report the four tap states in `web/src/pages/DraftTap.tsx` (FR-008)
- [X] T021 [US2] Evidence an active relay with a **last-relayed time**, never an assertion of health (FR-009, SC-006) — the tap was working on draft night and nobody could tell
- [X] T022 [US2] Distinguish a tap that has **stopped** from one never enabled (FR-010)
- [X] T023 [US2] Report an indeterminate state as unknown rather than guessing (FR-015)
- [X] T024 [US2] Assert the **completeness of both state sets** in `tests/room/state.test.ts` — all four tap states and all three room states reported distinctly (SC-005). Each state having a test does not prove the set is closed; a missing eighth state passes every task above

**Checkpoint**: nobody re-does setup to fix a system that is working.

---

## Phase 5: User Story 3 — Set the tap up in one step (P3)

**Goal**: install, click, done. Nothing shown, copied or kept.

**Independent test**: from a browser with nothing installed, enable the tap
without typing or pasting anything, then relay from a draft room.

- [X] T025 [US3] Write enablement tests FIRST in `tests/tap/enable.test.ts`: enablement requires an authenticated session and a genuine gesture, and **cannot be caused by a page the owner merely visits** (FR-018, SC-012)
- [X] T026 [US3] Add the acknowledgement endpoint in `src/api/tapEnable.ts`, issuing enablement for the signed-in account only (FR-016, FR-019)
- [X] T027 [US3] Match Draft Genie's own origin in `tap/` so the script can receive enablement from the page, keeping the ESPN match and `document_start` behaviour unchanged
- [X] T028 [US3] Make enablement idempotent — re-acknowledging must not interrupt a relay in progress (FR-020)
- [X] T029 [US3] Make enablement survive sign-out and session expiry while staying revocable (FR-020a). A draft outlasts a session, and under fan-out a relay dying mid-draft takes a **whole league's** feed with it
- [X] T030 [US3] State the reason on a failed enablement and leave any working state intact (FR-021)
- [X] T031 [US3] Assert in `tests/tap/enable.test.ts` that **no credential, code or identifier is ever rendered** to the user (FR-017, SC-004)
- [X] T032 [US3] Assert the ingest still rejects unattributable frames, and that attribution is **never inferred** from an armed session, a live-draft window or a league id alone (FR-022, FR-022a) — those constraints are weakest exactly when a draft is live
- [X] T033 [US3] Re-run `tests/tap/passivity.test.ts` against the changed userscript and confirm it still opens no connection to ESPN and has no send path (FR-041)

---

## Phase 6: User Story 4 — Don't load a finished draft into a new one (P4)

**Goal**: last week's completed mock cannot contaminate tonight's draft.

**Independent test**: with a completed draft room open, arm a fresh session and
confirm the finished draft's picks do not appear — **then reload a draft in
progress and confirm its own ledger still restores it**.

- [X] T034 [US4] Write BOTH ledger cases FIRST in `tests/draft/ledger.test.ts`: a complete ledger at a session with no observed incremental picks is **rejected**; a ledger at a session that has seen picks is **accepted**. Written together because rejecting everything and rejecting nothing both pass if only one case exists
- [X] T035 [US4] Implement the admission rule in `src/draft/reconcile.ts` around `applyLedger` per research §2 — a finished draft cannot be the first thing a session learns (FR-023)
- [X] T036 [US4] Stop selecting a ledger by coverage alone (FR-024). Coverage stays correct for choosing between ledgers **of the same draft**, which is what it was built for; it is what let a finished draft's ledger win outright
- [X] T037 [US4] Record every rejection with its reason (FR-025, SC-007), so a genuine recovery is never mistaken for contamination — and assert **zero** of a rejected ledger's picks entered the session
- [X] T038 [P] [US4] Report draft-room completion from the tap, building on `tap/draftEnd.ts`, as the direct signal where present (research §2) — authoritative when available, never depended on alone
- [X] T039 [US4] Add a regression test to `tests/draft/rebuild.test.ts` proving mid-draft rebuild still works — the containment rule must break **no** recovery case (FR-026, SC-008)

---

## Phase 7: User Story 5 — Start over without losing anything (P5)

**Goal**: reset a session; keep everything that is not the draft.

**Independent test**: reset, run a second mock, confirm no picks from the first
survive and the preferred list is untouched.

- [X] T040 [US5] Write reset tests FIRST in `tests/draft/reset.test.ts`: state and alarm cleared, **`closed` NOT set**, and the session arms again afterwards (FR-031). `shutdown()` sets `closed` and `arm()` returns early on it — that is why the only workaround was disconnect-and-reconnect
- [X] T041 [US5] Clear the completion stamp and the status **together** in `src/draft/session.ts` and `src/db/draft.ts`, and stop arming from producing a session that is `armed` while carrying `completed_at` (FR-044). Observed live 2026-08-06 on a freshly reconnected league; such a session can **never** transition to `live`, because that transition requires `completed_at IS NULL`. **This precedes the reset implementation** — clearing the stamp is only coherent once the split state cannot exist
- [X] T042 [US5] Add `reset()` to `src/draft/session.ts` clearing state and the alarm in place, leaving the object armable (FR-027)
- [X] T043 [US5] Implement the **shared live-draft guard** — one implementation serving both an owner-initiated reset (FR-030) and a sync-initiated void (FR-031d). Determine "live" from the session's armed state and the tap **heartbeat**, never from how recently a pick arrived (FR-031d1, FR-031d2): 005 measured 90 s+ gaps between human picks, so a recency test would void a live draft while a manager deliberates
- [X] T044 [US5] Expose reset as an owner action, refused or explicitly confirmed during a live draft (FR-030)
- [X] T045 [US5] Assert reset preserves the preferred list, league settings and tap enablement (FR-028, SC-009) — the workaround destroyed a preferred player on 2026-08-06
- [X] T046 [US5] Assert reset preserves retained frames and any archived draft (FR-029) — capture history is never destroyed by a reset
- [X] T047 [US5] Confirm reset is per manager under fan-out and cannot disturb a leaguemate's session

---

## Phase 8: User Story 8 — Notice when ESPN says the draft was reset (P6)

**UNBLOCKED — T001 passed on 2026-08-07.** `draftDetail.drafted` returned to
`false` on a real reset, corroborated by the pick record emptying. Build this
phase against the flag, with two measurements from the gate that change how:

1. **A reset rebuilds the pick skeleton, it does not shorten the array.**
   `picks.length` stayed 72 while filled picks went 72 → 0. Any corroborating
   check must count picks whose `playerId` is not the `-1` skeleton — and must
   not filter on sign, since D/ST ids are legitimately negative.
2. **A reset clears ESPN's draft date**, which means *no cron ever observes the
   reset*. `scanPreDraftWindow` is the only automatic caller of
   `refreshConnection`, and `findPreDraftWindowConnections`
   ([src/db/leagues.ts:250](../../src/db/leagues.ts:250)) selects on
   `draft_at IS NOT NULL` inside the window and then drops anything already
   `completed`. A league whose draft finished is excluded on both counts, and
   the stored snapshot keeps saying `completed: true` with the stale date — so
   the exclusion never lifts by itself. The observing sync must come from
   somewhere else. **T055 must not be written as though the cron will notice**;
   see the note on T055 below.

**Goal**: a draft reset in ESPN is noticed at the next sync, and the next draft
is captured cleanly without the owner doing anything.

**Independent test**: complete a draft, reset it in ESPN, sync, and confirm the
next draft is captured with none of the previous one's picks.

- [ ] T048 [US8] Write the detection tests FIRST in `tests/draft/reset-observed.test.ts`: a sync observing a previously completed draft no longer reported as completed voids the session; a **live** session is never voided; an unavailable or ambiguous report voids nothing (FR-031f)
- [ ] T049 [US8] Key detection on a **change in ESPN's own report**, never on a disagreement between the session and ESPN (FR-031a1). Two verified reasons: mocks never appear in ESPN's league record at all (`started=0, completed=0` measured against two captured 72-pick drafts), so a disagreement rule fires endlessly for them; and the tap sees a real draft finish seconds before ESPN's flush lands, so a disagreement rule would void a genuinely finished draft inside that window, before it is archived
- [ ] T050 [US8] Compare stored against freshly parsed draft completion in `src/sync/refresh.ts` — the snapshot already carries it, so this is a comparison that does not exist rather than data that is missing
- [ ] T051 [US8] Void the session on a confirmed reset in `src/db/draft.ts`, clearing `completed_at` so the latch releases, and reuse US5's `reset()` so there is one reset path reached two ways (FR-031a)
- [ ] T052 [US8] Void **every** manager's session for that league and season, not only the one whose sync observed it (FR-031b) — under fan-out there is more than one
- [ ] T053 [US8] Assert retained frames and any archived record of the reset draft **survive** the void (FR-031c). A draft that really happened stays history, and 008's corpus may already depend on it
- [ ] T054 [US8] Record the reason and the triggering observation on every void (FR-031e), and prove in test that a live draft cannot be voided by any sync result, using T043's shared guard (FR-031d, SC-009b)
- [ ] T055 [US8] Verify SC-009a end to end: a draft reset in ESPN is noticed at the next sync and the next draft is captured with none of the previous one's picks, **with no action by the owner**
  - **T001 found that no sync arrives on its own.** A completed draft is excluded from the pre-draft scan by both its `completed` flag and its now-null `draft_at`, and nothing else refreshes a connection automatically — the only other callers of `refreshConnection` are the league API and the credential API, both user-triggered. So "the next sync" is today an owner opening the app, and SC-009a's "with no action by the owner" is **not currently satisfiable**. Decide before writing this test: either widen the automatic scan so a recently-completed league is re-read for some period after its draft (the smaller change, and it makes the void reachable), or amend SC-009a to say the reset is noticed at the next sync *whenever one occurs*. Do not write a test that passes only because the test harness called the sync itself — that would assert the mechanism into existence

---

## Phase 9: User Story 6 — Simplify the Draft Tap page (P7)

**Goal**: the page describes what setup now is.

**Independent test**: someone who has never set the tap up succeeds from the page
alone, without asking a question.

- [X] T056 [US6] Remove the pairing instructions from `web/src/pages/DraftTap.tsx`, leaving install / enable / state (FR-032)
- [X] T057 [US6] Keep a way to stop relaying, stating what stops — **including that ESPN is unaffected** (FR-033)
- [X] T058 [P] [US6] List enabled browsers and allow each to be revoked individually (FR-034)
- [X] T059 [US6] State that live relaying requires desktop Chrome (FR-035) — 010's permanent limitation, and the reason US1 matters

---

## Phase 10: User Story 7 — Keep capture history reachable (P8)

**Goal**: a reconnect does not orphan the corpus.

**Independent test**: reconnect a league, then admit a draft captured beforehand.

- [X] T060 [US7] Scope frames by `account_id` rather than `connection_id` in `scripts/lab-admit.ts` (FR-036) — the column is already on `tap_batches`, so this is a change of predicate, not of schema
- [X] T061 [US7] Allow a leaguemate's frames while taking perspective from the operator's own account (FR-037), which is the narrower and correct version of the over-correction shipped in 008 T031
- [X] T062 [P] [US7] Record `relayedByAnotherManager` on the corpus entry (FR-038) per [data-model.md](data-model.md) §6
- [X] T063 [US7] Assert in `tests/lab/boundary.test.ts` that it remains **impossible** to build an entry carrying another account's team, settings or preferred list (FR-039, SC-011)
- [ ] T064 [US7] Re-admit the frames orphaned by the 2026-08-06 reconnect and confirm they load (SC-010)

---

## Phase 11: Polish & Cross-Cutting

**Last, and it must stay last** — an earlier draft of this file put Polish before
US8, so "record 011 as shipped" would have run before a third of the feature
existed.

- [ ] T065 Run a mutation sweep over the ledger admission rule, the fan-out audience, the perspective split, the live-draft guard and the duplicate convergence — confirm each is killed by a **named** test, and report the test **count** that ran, not only pass/fail
- [ ] T066 [P] Assert **no file under `src/engine/` changed** across this feature (FR-040). The one Principle IV boundary here, and the only one otherwise unguarded — 008 asserted its equivalent structurally rather than trusting it
- [ ] T067 [P] Verify SC-001 and SC-013 by measuring delivery latency for both a relaying and a non-relaying manager against T003's baseline
- [ ] T068 [P] Verify no ESPN credential is read, logged or transmitted anywhere the feature touches (FR-042), and that relayed frames remain numeric-only (FR-043)
- [ ] T069 Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run privacy` — all clean
- [ ] T070 Walk [quickstart.md](quickstart.md) end to end with **two accounts and one mock draft**, correcting anything that does not match what was built. This is the configuration every defect in this feature was found in, and the only one that can prove US1 at all
- [ ] T071 Record 011 in `ROADMAP.md` as shipped, with T001's gate result, the measured latency, what the mutation sweep found, and anything the build learned that the plan did not know

---

## Dependencies

```
T001 GATE ────────────────────────────────► blocks Phase 8 only
Phase 1 (Setup) ──► Phase 2 (Foundational) ── blocks everything
                          │
                          ├─► Phase 3  US1 (P1)  fan-out ─────── the large one
                          ├─► Phase 4  US2 (P2)  honest state ── independent
                          ├─► Phase 5  US3 (P3)  enablement ──► Phase 9 US6 (page)
                          ├─► Phase 6  US4 (P4)  containment ── independent
                          ├─► Phase 7  US5 (P5)  reset ──► Phase 8 US8 (observed reset)
                          └─► Phase 10 US7 (P8)  lab scoping ── independent
                                                                    │
                                          Phase 11 (Polish) ◄───────┘ after everything
```

- **US2, US4, US5 and US7 depend on nothing but Phase 2.** None needs fan-out.
- **US8 depends on US5** — T051 reuses `reset()` and T054 reuses T043's guard, so
  there is one reset path and one live-draft guard, each reached two ways.
- **US8 is additionally gated by T001.** It is the only story whose premise rests
  on an unverified external behaviour.
- **US6 depends on US3** — the page cannot describe a setup that does not exist.
- **T041 precedes T042**: clearing a completion stamp is only coherent once
  arming can no longer produce a session that is `armed` while carrying one.
- **US1 is the only story touching the delivery path**, which is why a bug there
  is the only one that could affect every manager at once.

## Parallel opportunities

Every `[P]` is a genuinely distinct file; tasks extending the same file stay
sequential.

- **Phase 1**: T003 is a measurement, independent of T002's code. T001 is not
  marked — it gates Phase 8 and should be run first regardless.
- **Phase 2**: T006 is a different file from T004/T005.
- **Phase 3**: T010 extends `fanout.test.ts` alongside implementation in `src/`.
- **Phase 4**: T020 is `DraftTap.tsx`; the rest are `DraftRoom.tsx` or its test.
- **Phase 6**: T038 is in `tap/`, away from `reconcile.ts`.
- **Phase 10**: T062 is the corpus shape, distinct from the admitting script.
- **Phase 11**: T066, T067 and T068 are independent checks; T065, T069 and T070
  each run or mutate the whole suite and must not race.

## Implementation strategy

**MVP is Phase 1 → Phase 2 → Phase 3.** That is the story that changes whether
the product works for anyone who cannot run a userscript — most managers.

**If time is short, do Phases 4, 6, 7 and 8 first** (US2, US4, US5, US8). They
are the sharp-edged bugs plus the automatic recovery for them, each small, and
**none depends on fan-out**. US8 is the one that would have spared the whole
2026-08-06 evening — the draft was reset in ESPN, so no app action was ever going
to fire.

**Run T001 before anything else.** It costs one read and it decides whether
Phase 8 exists.

**If the work stops cohering**, split **US1 from the rest** — not back along the
011/012 line, which was the wrong seam and had to be rejoined.

## The five traps in this feature

1. **Re-keying the session.** The tempting move for "make it league-wide" is to
   address the object by league. It also forces perspective out of the object and
   back in per viewer — inventing the layer whose absence caused the T031
   perspective bleed. Fan out instead. T008, T009.

2. **A ledger rule that breaks recovery.** Rejecting contamination is easy;
   rejecting it *without* breaking reload is the whole difficulty, because
   ledgers exist to restore a draft — 3 of 72 picks in 010's corpus arrived only
   by ledger. A rule that rejects everything passes any test written only for the
   contamination case. T034 writes both cases together, T039 guards recovery.

3. **Perspective bleed.** Under fan-out every session sees the same frames, so
   the only thing keeping one manager's board theirs is that scope stays local.
   The 2026-08-06 corpus entry carried another manager's team because ownership
   was inferred from volume. T005, T010, T063.

4. **First-writer-wins on a correction.** Duplicate suppression that keeps the
   earliest frame looks like working deduplication until a corrected frame
   arrives second. `foldBatches` already prefers coverage over arrival for this
   exact reason. T015.

5. **A live-draft guard built on pick recency.** "Currently receiving picks"
   sounds obvious and is a trap: 005 measured 90 s+ between human picks and
   concluded liveness comes from the **heartbeat**, never from pick silence. A
   recency test voids a live draft while someone deliberates. T043.
