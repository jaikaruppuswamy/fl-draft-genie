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

- [ ] T001 Add a league-scoped connection lookup to `src/db/leagues.ts` — every connection for one `(espn_league_id, season)`, across accounts — since fan-out needs the audience before it can deliver to it
- [ ] T002 [P] Record in `specs/011-shared-draft-sessions/research.md` the measured baseline for SC-001 before any change: current delivery latency for the relaying manager, so "unchanged" is a comparison rather than an assertion

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the vocabulary every story needs. **No user story starts until this
phase is done.**

- [ ] T003 Split `SessionScope` in `src/draft/session.ts` into its shared half (`espnLeagueId`, `season`, `order`) and per-manager half (`accountId`, `connectionId`, `myTeamId`, `totalPicks`) per [data-model.md](data-model.md) — types only, no behaviour change yet, so the compiler finds every site that conflates them
- [ ] T004 Write the scope-split guard in `tests/draft/scope.test.ts`: a session's per-manager fields MUST come from its own connection and never from a relaying account. **`totalPicks` is per-manager** — two managers recorded 11 and 12 rounds for the same draft on 2026-08-06
- [ ] T005 [P] Define the three draft-room states and four tap states in one place per [data-model.md](data-model.md) §4, each carrying a remedy, so the two surfaces cannot drift into different vocabularies

**Checkpoint**: `npm test` green; the conflation sites are visible in the type
errors T003 produces.

---

## Phase 3: User Story 1 — See the draft when a leaguemate is relaying (P1) 🎯 MVP

**Goal**: a manager with no tap sees the draft, from their own perspective.

**Independent test**: with one manager relaying and a second not, open the second
manager's draft room and confirm picks arrive with **their** team highlighted.

- [ ] T006 [US1] Write fan-out tests FIRST in `tests/draft/fanout.test.ts`: a frame for a league arms **every** connected manager's session; each builds state from its own scope; a non-member receives nothing; nothing in a delivered payload names the relayer
- [ ] T007 [US1] Make arming league-wide in `src/api/tap.ts` — arm every connection returned by T001, each with its own scope. **Sessions currently arm from their own tap's first frame, so a manager with no tap has no session at all**; this is the change that gives them one
- [ ] T008 [US1] Nudge every armed session for the league in `src/api/tap.ts`, keeping the existing after-response scheduling so a Durable Object round trip never sits on the tap's request path
- [ ] T009 [P] [US1] Assert in `tests/draft/fanout.test.ts` that a delivered payload contains no relayer identity — account, connection, install or session id (FR-003, SC-003)
- [ ] T010 [US1] Surface a settings disagreement rather than resolving it, in `src/draft/session.ts`: each session uses its own `totalPicks`, and a mismatch across managers is reported (FR-005)
- [ ] T011 [US1] Report "no active relay" and its remedy in `web/src/pages/DraftRoom.tsx` (FR-006)
- [ ] T012 [US1] Report a relay that **stopped mid-draft** with the same message for every manager, naming what would restore it, and never presentable as a draft that has not started (FR-006a)
- [ ] T013 [US1] Accept several relays and converge on pick identity in `src/draft/feed.ts` (FR-007a)
- [ ] T014 [US1] Prefer the frame carrying **more information** over the one that arrived first (FR-007b). `foldBatches` already prefers ledger coverage over arrival order for exactly this reason — a tap flushing after an outage sends an old snapshot with a new timestamp
- [ ] T015 [US1] Measure delivery latency for a non-relaying manager against T002's baseline and confirm 005's budget holds (SC-001)

**Checkpoint**: a manager on an iPad sees the draft.

---

## Phase 4: User Story 2 — Tell the truth about what is working (P2)

**Goal**: neither surface ever mistakes one failure for another.

**Independent test**: force each surface into each state and confirm every one is
reported distinctly, with a remedy.

- [ ] T016 [US2] Write state tests FIRST in `tests/room/state.test.ts`: **no session armed ⇒ waiting for the draft, NOT a reachability failure** — the false alarm that fired seven minutes before a draft on 2026-08-05
- [ ] T017 [US2] Distinguish waiting / cannot-reach / reachable-but-not-receiving in `web/src/pages/DraftRoom.tsx`, each with its remedy (FR-011 – FR-013)
- [ ] T018 [US2] Keep a transient reconnection from presenting as failure while it is still expected to succeed (FR-014)
- [ ] T019 [P] [US2] Report the four tap states in `web/src/pages/DraftTap.tsx` (FR-008)
- [ ] T020 [US2] Evidence an active relay with a **last-relayed time**, never an assertion of health (FR-009, SC-006) — the tap was working on draft night and nobody could tell
- [ ] T021 [US2] Distinguish a tap that has **stopped** from one never enabled (FR-010)
- [ ] T022 [US2] Report an indeterminate state as unknown rather than guessing (FR-015)

**Checkpoint**: nobody re-does setup to fix a system that is working.

---

## Phase 5: User Story 3 — Set the tap up in one step (P3)

**Goal**: install, click, done. Nothing shown, copied or kept.

**Independent test**: from a browser with nothing installed, enable the tap
without typing or pasting anything, then relay from a draft room.

- [ ] T023 [US3] Write enablement tests FIRST in `tests/tap/enable.test.ts`: enablement requires an authenticated session and a genuine gesture, and **cannot be caused by a page the owner merely visits** (FR-018, SC-012)
- [ ] T024 [US3] Add the acknowledgement endpoint in `src/api/tapEnable.ts`, issuing enablement for the signed-in account only (FR-016, FR-019)
- [ ] T025 [US3] Match Draft Genie's own origin in `tap/` so the script can receive enablement from the page, keeping the ESPN match and `document_start` behaviour unchanged
- [ ] T026 [US3] Make enablement idempotent — re-acknowledging must not interrupt a relay in progress (FR-020)
- [ ] T027 [US3] Make enablement survive sign-out and session expiry while staying revocable (FR-020a). A draft outlasts a session, and under fan-out a relay dying mid-draft takes a **whole league's** feed with it
- [ ] T028 [US3] State the reason on a failed enablement and leave any working state intact (FR-021)
- [ ] T029 [US3] Assert in `tests/tap/enable.test.ts` that **no credential, code or identifier is ever rendered** to the user (FR-017, SC-004)
- [ ] T030 [US3] Assert the ingest still rejects unattributable frames, and that attribution is **never inferred** from an armed session, a live-draft window or a league id alone (FR-022, FR-022a) — those constraints are weakest exactly when a draft is live
- [ ] T031 [US3] Re-run `tests/tap/passivity.test.ts` against the changed userscript and confirm it still opens no connection to ESPN and has no send path (FR-041)

---

## Phase 6: User Story 4 — Don't load a finished draft into a new one (P4)

**Goal**: last week's completed mock cannot contaminate tonight's draft.

**Independent test**: with a completed draft room open, arm a fresh session and
confirm the finished draft's picks do not appear — **then reload a draft in
progress and confirm its own ledger still restores it**.

- [ ] T032 [US4] Write BOTH ledger cases FIRST in `tests/draft/ledger.test.ts`: a complete ledger at a session with no observed incremental picks is **rejected**; a ledger at a session that has seen picks is **accepted**. Written together because rejecting everything and rejecting nothing both pass if only one case exists
- [ ] T033 [US4] Implement the admission rule in `src/draft/reconcile.ts` around `applyLedger` per research §2 — a finished draft cannot be the first thing a session learns
- [ ] T034 [US4] Stop selecting a ledger by coverage alone (FR-024). Coverage remains right for choosing between ledgers **of the same draft**; it is what let a finished draft's ledger win outright
- [ ] T035 [US4] Record every rejection with its reason (FR-025), so a genuine recovery is never mistaken for contamination
- [ ] T036 [P] [US4] Report draft-room completion from the tap, building on `tap/draftEnd.ts`, as the direct signal where present (research §2) — authoritative when available, never depended on alone
- [ ] T037 [US4] Add a regression test to `tests/draft/rebuild.test.ts` proving mid-draft rebuild still works — the containment rule must break **no** recovery case (FR-026, SC-008)

---

## Phase 7: User Story 5 — Start over without losing anything (P5)

**Goal**: reset a session; keep everything that is not the draft.

**Independent test**: reset, run a second mock, confirm no picks from the first
survive and the preferred list is untouched.

- [ ] T038 [US5] Write reset tests FIRST in `tests/draft/reset.test.ts`: state and alarm cleared, **`closed` NOT set**, and the session arms again afterwards (FR-031). `shutdown()` sets `closed` and `arm()` returns early on it — that is why the only workaround was disconnect-and-reconnect
- [ ] T039 [US5] Add `reset()` to `src/draft/session.ts` clearing state and the alarm in place, leaving the object armable
- [ ] T040 [US5] Expose reset as an owner action, refused or explicitly confirmed during a live draft (FR-030)
- [ ] T041 [US5] Assert reset preserves the preferred list, league settings and tap enablement (FR-028) — the workaround destroyed a preferred player on 2026-08-06
- [ ] T042 [US5] Assert reset preserves retained frames and any archived draft (FR-029) — capture history is never destroyed by a reset
- [ ] T043 [US5] Confirm reset is per manager under fan-out and cannot disturb a leaguemate's session

---

## Phase 8: User Story 6 — Simplify the Draft Tap page (P6)

**Goal**: the page describes what setup now is.

**Independent test**: someone who has never set the tap up succeeds from the page
alone, without asking a question.

- [ ] T044 [US6] Remove the pairing instructions from `web/src/pages/DraftTap.tsx`, leaving install / enable / state (FR-032)
- [ ] T045 [US6] Keep a way to stop relaying, stating what stops — **including that ESPN is unaffected** (FR-033)
- [ ] T046 [P] [US6] List enabled browsers and allow each to be revoked individually (FR-034)
- [ ] T047 [US6] State that live relaying requires desktop Chrome (FR-035) — 010's permanent limitation, and the reason US1 matters

---

## Phase 9: User Story 7 — Keep capture history reachable (P7)

**Goal**: a reconnect does not orphan the corpus.

**Independent test**: reconnect a league, then admit a draft captured beforehand.

- [ ] T048 [US7] Scope frames by `account_id` rather than `connection_id` in `scripts/lab-admit.ts` (FR-036) — the column is already on `tap_batches`, so this is a change of predicate, not of schema
- [ ] T049 [US7] Allow a leaguemate's frames while taking perspective from the operator's own account (FR-037), which is the narrower and correct version of the over-correction shipped in 008 T031
- [ ] T050 [P] [US7] Record `relayedByAnotherManager` on the corpus entry (FR-038) per [data-model.md](data-model.md) §6
- [ ] T051 [US7] Assert in `tests/lab/boundary.test.ts` that it remains **impossible** to build an entry carrying another account's team, settings or preferred list (FR-039, SC-011)
- [ ] T052 [US7] Re-admit the frames orphaned by the 2026-08-06 reconnect and confirm they load

---

## Phase 10: Polish & Cross-Cutting

- [ ] T053 Run a mutation sweep over the ledger admission rule, the fan-out audience, the perspective split and the duplicate convergence — confirm each is killed by a **named** test, and report the test **count** that ran, not only pass/fail
- [ ] T054 [P] Verify SC-001 and SC-013 by measuring delivery latency for both a relaying and a non-relaying manager against T002's baseline
- [ ] T055 [P] Verify no ESPN credential is read, logged or transmitted anywhere the feature touches (FR-042), and that relayed frames remain numeric-only (FR-043)
- [ ] T056 Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run privacy` — all clean
- [ ] T057 Walk [quickstart.md](quickstart.md) end to end with **two accounts and one mock draft**, correcting anything that does not match what was built. This is the configuration every defect in this feature was found in, and the only one that can prove US1 at all
- [ ] T058 Record 011 in `ROADMAP.md` as shipped, with the measured latency, what the mutation sweep found, and anything the build learned that the plan did not know

---

## Dependencies

```
Phase 1 (Setup) ──► Phase 2 (Foundational) ── blocks everything
                          │
                          ├─► Phase 3  US1 (P1)  fan-out          ── the large one
                          ├─► Phase 4  US2 (P2)  honest state     ── independent
                          ├─► Phase 5  US3 (P3)  enablement ──► Phase 8 US6 (page)
                          ├─► Phase 6  US4 (P4)  containment     ── independent
                          ├─► Phase 7  US5 (P5)  reset ──┐
                          ├─► Phase 11 US8 (P6)  reset observed from ESPN
                          │        (reuses US5's reset(); run Phase 7 first)
                          └─► Phase 9  US8→US7 (P8) lab scoping ── independent
                                                   └─► Phase 10 (Polish)
```

- **US2, US4, US5 and US7 depend on nothing but Phase 2.** None needs fan-out.
- **US8 depends on US5**, and only on it: T061 reuses `reset()` rather than
  adding a second reset path. It does not need fan-out either — though T062 has
  more sessions to void once fan-out lands, which is why it names the audience
  rather than assuming one.
- **US6 depends on US3** — the page cannot describe a setup that does not exist.
- **US1 is the only story that touches the delivery path**, which is why a bug
  there is the only one that could affect every manager at once.
- **T012 (relay stopped) belongs to US1** rather than US2, because the state only
  exists once a leaguemate's relay can be depended on.

## Parallel opportunities

Every `[P]` is a genuinely distinct file; tasks extending the same file stay
sequential.

- **Phase 1**: T002 is documentation, independent of T001's code.
- **Phase 2**: T005 is a different file from T003/T004.
- **Phase 3**: T009 extends `fanout.test.ts` alongside implementation work in
  `src/`.
- **Phase 4**: T019 is `DraftTap.tsx`; the rest are `DraftRoom.tsx`.
- **Phase 6**: T036 is in `tap/`, away from `reconcile.ts`.
- **Phase 9**: T050 is the corpus shape, distinct from the admitting script.
- **Phase 10**: T054 and T055 are independent measurements; T053, T056 and T057
  each run or mutate the whole suite and must not race.

## Implementation strategy

**MVP is Phase 1 → Phase 2 → Phase 3.** That is the story that changes whether
the product works for anyone who cannot run a userscript — most managers.

**If time is short, do Phases 4, 6, 7 and 11 first** (US2, US4, US5, US8). They
are the sharp-edged bugs plus the automatic recovery for them, each small, and
**none depends on fan-out**. US8 is the one that would have spared the whole
2026-08-06 evening: the draft was reset in ESPN, so no app action was ever going
to fire. US1 is both
the largest value and the largest change; taking it carefully beats taking it
first.

**If the work stops cohering**, split **US1 from the rest** — not back along the
011/012 line, which was the wrong seam and had to be rejoined.

## The five traps in this feature

1. **Re-keying the session.** The tempting move for "make it league-wide" is to
   address the object by league. It also forces perspective out of the object and
   back in per viewer — inventing the layer whose absence caused the T031
   perspective bleed. Fan out instead. T007, T008.

2. **A ledger rule that breaks recovery.** Rejecting contamination is easy;
   rejecting it *without* breaking reload is the whole difficulty, because
   ledgers exist to restore a draft — 3 of 72 picks in 010's corpus arrived only
   by ledger. A rule that rejects everything passes any test written only for the
   contamination case. T032 writes both cases together, T037 guards the recovery
   one.

3. **Perspective bleed.** Under fan-out every session sees the same frames, so
   the only thing keeping one manager's board theirs is that scope stays local.
   The 2026-08-06 corpus entry carried another manager's team because ownership
   was inferred from volume. T004, T051.

4. **First-writer-wins on a correction.** Duplicate suppression that keeps the
   earliest frame looks like working deduplication until a corrected frame
   arrives second. `foldBatches` already prefers coverage over arrival for this
   exact reason. T014.

5. **A state that asserts health.** "Relaying" without a last-relayed time is a
   claim, not evidence — and an unevidenced claim is what made a working tap look
   broken and got a valid credential revoked twice under time pressure. T020.

---

## Phase 11: User Story 8 — Notice when ESPN says the draft was reset (P6)

**Executed before Phases 8–9 despite the higher task numbers.** Task ids are
identifiers, not an execution order — the dependency graph governs, and this
story outranks the page and the lab.

**Goal**: a draft reset in ESPN is noticed at the next sync, and the next draft
is captured cleanly without the owner doing anything.

**Independent test**: complete a draft, reset it in ESPN, sync, and confirm the
next draft is captured with none of the previous one's picks.

**Verified before writing these tasks**: the sync already *sees* it —
`refreshConnection` requests `mDraftDetail` and `parseDraft` maps
`draftDetail.drafted → completed` into the stored snapshot — and nothing acts on
it. Both status transitions in `src/db/draft.ts` are guarded
`WHERE completed_at IS NULL`, so once a draft completes **no route moves it
back**.

- [ ] T059 [US8] Write the detection tests FIRST in `tests/draft/reset-observed.test.ts`: a sync observing a previously completed draft no longer reported as completed voids the session; a session **currently receiving picks** is never voided; an unavailable or ambiguous report voids nothing
- [ ] T060 [US8] Compare stored against freshly parsed draft completion in `src/sync/refresh.ts` — the snapshot already carries it, so this is a comparison that does not exist rather than data that is missing
- [ ] T061 [US8] Void the session on a confirmed reset in `src/db/draft.ts`, clearing `completed_at` so the latch releases, and reuse US5's `reset()` on the Durable Object so there is one reset path rather than two (FR-031a)
- [ ] T062 [US8] Void **every** manager's session for that league and season, not only the one whose sync observed it (FR-031b) — under fan-out there is more than one
- [ ] T063 [US8] Assert retained frames and any archived record of the reset draft **survive** the void (FR-031c). A draft that really happened stays history, and 008's corpus may already depend on it
- [ ] T064 [US8] Record the reason and the triggering observation on every void (FR-031e), and prove in test that a live draft cannot be voided by any sync result (FR-031d, SC-009b)
- [ ] T065 [US5] Clear the completion stamp and the status **together** in `src/draft/session.ts` and `src/db/draft.ts`, and stop arming from producing a session that is `armed` while carrying `completed_at` (FR-031g). Observed live 2026-08-06 on a freshly reconnected league: arming writes status directly and bypasses the latch, and the resulting session can never transition to `live` because that transition requires `completed_at IS NULL`
- [ ] T066 [US8] Key detection on a **change in ESPN's own report**, never on a disagreement between the session and ESPN (FR-031a1). Two verified reasons: mocks never appear in ESPN's league record at all (`started=0, completed=0` measured against two captured 72-pick drafts), so a disagreement rule fires endlessly for them; and the tap sees a real draft finish seconds before ESPN's flush lands, so a disagreement rule would void a genuinely finished draft inside that window, before it is archived
