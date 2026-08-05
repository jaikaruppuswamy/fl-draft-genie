---

description: "Task list for 006-recommendation-engine"
---

# Tasks: Recommendation Engine (006)

**Input**: Design documents from `specs/006-recommendation-engine/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/api.md](contracts/api.md), [quickstart.md](quickstart.md) — and the deployed 001–005 + 010 build.

> **Revised 2026-08-05 after `/speckit-analyze`.** Fourteen findings, all fixed.
> Four are new tasks — keepers (T012), a drafted player absent from the board
> (T013), the on-deck obligation (T030), and signal-removal sensitivity (T035).
> The bundle loader moved out of `src/engine/` so the purity guard needs no
> exemption. IDs were renumbered to stay sequential; nothing had been started.

**Tests**: requested, and first-class. The spec defines SC-001…SC-014 as measurable
outcomes, FR-014 requires offline replay, and FR-027 states an invariant that only
a test can hold. For the pure rule modules the tests are written **before** the
implementation they cover — the discipline that caught 005's silent pick deletion.

**Mutation testing is the acceptance bar**, not line coverage. A rule whose
corruption no test detects is not tested. 005 shipped two tests that survived
their own mutations; both were found by deliberately breaking the code and
watching nothing fail.

## Format: `[ID] [P?] [Story] Description`

- **[P]** — parallelisable: a **different file** from every other task that could
  run alongside it, and no dependency on an incomplete task
- **[US1]…[US4]** — the user story a task serves; absent for Setup, Foundational and Polish

## Path Conventions

Single Cloudflare Worker + React SPA, as in 001–005: `src/` (Worker), `web/src/`
(SPA), `tests/` (Vitest), `migrations/` (D1). New module tree `src/engine/`.

## Prerequisites already satisfied

Do **not** re-derive these.

- **The board** — 002/003 shipped. `buildLeagueBoard()` already returns
  league-scored `projected_points`, `adp`, `overall_rank` and `tier`.
- **ADP reaches the client** — verified against production 2026-08-05.
  522/522 projected players carry a value.
- **Player search needs no backend** — the board endpoint returns the whole
  board and client-side name+position filtering already ships in
  `web/src/pages/LeagueBoard.tsx:53-61`. Reuse that pattern; do **not** add a
  search endpoint or a `full_name` index.
- **Turn arithmetic exists** — 005's `src/draft/snake.ts` already provides
  `picksUntilTurn()` (returns **null** when there is no next turn — that is
  FR-023, already correct) and `remainingSchedule()`.
- **Keeper data exists** — `CompletedPick.keeper` in 001's parser,
  `draft_picks.keeper` and `draft_keepers` in 005's archive. Nothing consumes
  them yet; T010/T012 is where that changes.
- **The corpus exists** — the 72-pick real draft, which replay proved agrees
  with ESPN's independent post-draft record on all 72 picks.
- **Withholding exists** — 005's `src/draft/liveness.ts` computes the verdict
  and its `WithholdReason` union. Reuse it; do not invent a second liveness notion.

---

## Phase 1: Setup

- [ ] T001 Create the module tree `src/engine/` and the test directory `tests/engine/`, per plan.md's Structure Decision
- [ ] T002 Add the **structural guard** in `tests/engine/purity.test.ts`. Two assertions, both about properties that decay silently if only a comment defends them: (a) **FR-010** — every file under `src/engine/` is read and must not import `cloudflare:`, `hono`, `../db/` or `../api/`, nor reference `Date`, `Math.random`, `fetch` or `crypto`; **no exemptions** — the bundle loader lives outside the tree precisely so none is needed. (b) **FR-011 / Constitution IV** — no file under `src/api/` imports from `src/engine/constants.ts`, and no registered route path contains `settings`, so a rule weight can never become a user-facing knob

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user story work begins until this phase is complete.**

- [ ] T003 Write migration `migrations/0009_preferred.sql` creating `preferred_players` per [data-model.md](data-model.md), cascading from **both** `league_connections` and `accounts`. Note in the file header why this cascade is the OPPOSITE of `draft_archives`: an archive is season history that must outlive a disconnect, a preferred list is live intent that must not
- [ ] T004 [P] Define the engine's shapes in `src/engine/types.ts` — `EngineBundle`, `EngineState` (including the `keepers` set), `RankedBoard`, `RankedEntry`, `Recommendation`, `Explanation`, `Adjustment`, `Warning`, `MissingInput` — exactly as specified in [data-model.md](data-model.md)
- [ ] T005 [P] Create `src/engine/constants.ts` holding **every** weight and size in one file: `SHORTLIST_SIZE`, `WEIGHT.{offense,sos,oline,bye,scarcity}`, `PREFERRED_CAP`, `ADP_COMBINED_CAP`, `FLOOR_DENSITY_RATIO`, and the position-relevance matrix. This file exists so the later tuning session has exactly one place to look — a magnitude hardcoded inside a rule defeats its whole purpose
- [ ] T006 [P] Implement account-scoped queries in `src/db/preferred.ts`: `listPreferred`, `addPreferred`, `removePreferred`. **Every query filters on `account_id` in the SQL**, following `readBatchesAfter`'s pattern — a wrong check at a route must not be able to leak another owner's list (FR-020)
- [ ] T007 [P] Implement ADP floor detection in `src/projections/adpFloor.ts` by **density ratio** per research §3. Do NOT hardcode 169.9 — that is this season's number. Return `null` when no floor is detectable
- [ ] T008 Test `tests/engine/adp-floor.test.ts` against a production-shaped distribution (145 players spread below 150, ~325 clustered in a 2.6-unit band near the max) and assert the detector finds the band at ratios from 5 to 50, so the constant is provably not load-bearing. Include a **no-floor** set and assert `null`
- [ ] T009 Implement the bundle loader in `src/db/engineBundle.ts` — board, signals, roster/team count, preferred set, adpFloor, freshness — assembling `EngineBundle` from D1. **It lives in `src/db/`, not `src/engine/`**: it reads five tables, and putting it in the engine tree would force T002's guard to carry a named exemption, which is how a categorically pure tree stops being one
- [ ] T010 Implement `src/engine/state.ts` deriving `EngineState` from 005's `SessionSnapshot`. **`drafted` is the union of `confirmed`, `pending` and `keepers`, by player identity.** A pending pick is a real observed pick whose overall number is unconfirmed, so the player is unambiguously gone. A keeper is rostered before pick 1 — on **any** team, not just the owner's. Either one treated as available recommends a player nobody can take
- [ ] T011 Test `tests/engine/state.test.ts` asserting a pending-only pick removes its player from the available pool, and that `gapToNextTurn` is `null` at the owner's final pick rather than zero or a large number
- [ ] T012 Extend `tests/engine/state.test.ts` for **keepers** (FR-002, research §7a): another team's kept player is unavailable; the owner's kept players appear in `myRoster` and count toward roster needs; a redraft league with no keepers is unaffected. Every league this project has tested against is a redraft, so this bug would be invisible until someone else's league hit it
- [ ] T013 Extend `tests/engine/state.test.ts` for a **drafted player absent from the board** — obscure, newly added, or a negative D/ST id around −16000. The pool is built by removing ids from the board, so an unknown id must remove nothing and crash nothing. This is the exact class of bug that made 010's capture report 66 of 72 picks

---

## Phase 3: User Story 1 — Tell me who to pick (P1) 🎯 MVP

**Goal**: a total ranked ordering of every available player, best first, in the league's own scoring.

**Independent test**: replay the archived draft to any pick, request a recommendation, confirm the list contains only undrafted players ordered by the engine's own value.

- [ ] T014 [P] [US1] Test `tests/engine/value.test.ts` for replacement level: a position with zero starter slots baselines at its own best player; a position whose pool is shorter than its boundary baselines at its worst; unprojected players carry no value and rank last
- [ ] T015 [US1] Extend `tests/engine/value.test.ts` for the **value-greedy FLEX allocation**: the same pool under full-PPR and standard scoring must allocate flex slots differently, pulling more receivers across the boundary under PPR — with no setting changing. This is Constitution III made testable
- [ ] T016 [P] [US1] Test `ROUND_VALUE` in `tests/engine/round-value.test.ts`, **including the degenerate tail**: fewer than `teamCount + 1` players left falls back to top-minus-last, fewer than two returns 0. The end of the draft is where this is most likely to divide by nothing
- [ ] T017 [US1] Implement `src/engine/value.ts` — replacement boundaries from `RosterSnapshot.slots` × `teamCount`, value-greedy FLEX fill (ESPN slots 3=RB/WR, 5=WR/TE, 7=OP, 23=FLEX), `value = points − replacement[position]`, and `ROUND_VALUE`
- [ ] T018 [P] [US1] Test `tests/engine/adp.test.ts`: a **floored ADP produces no adjustment in either direction** (SC-012); a null ADP likewise; `gapToNextTurn === null` disables survival entirely and reports **no missing signal** (FR-023); the survival ramp is monotone between its endpoints
- [ ] T019 [US1] Extend `tests/engine/adp.test.ts` with the **shared clamp**: a player who both fell past his ADP and will not survive must not collect twice — `|slot_value| + |survival| <= ADP_COMBINED_CAP × ROUND_VALUE`. Assert it by constructing exactly that player, not by inspection
- [ ] T020 [US1] Implement `src/engine/adp.ts` — floor application, `slot_value` (positive when the player has fallen; reaching earns no bonus, it is simply not rewarded), `survival` (linear ramp between honest endpoints), and the shared clamp
- [ ] T021 [P] [US1] Test `tests/engine/adjustments.test.ts` for the **three team signals** (research §5a): the relevance matrix is honoured (O-line moves RB and QB, never WR/TE/K/DST); a **non-applicable** signal produces no adjustment, which is different from a zero one; a missing signal is recorded in `missing[]`
- [ ] T022 [US1] Extend `tests/engine/adjustments.test.ts` for the **two computed adjustments** (research §5b, §5c): a bye clash scales by the position's starter slots, so a second starting RB on the same bye weighs far more than a third bench WR; the positional-run window uses the last `teamCount` picks and produces **no** adjustment when no picks have been made
- [ ] T023 [US1] Implement `src/engine/adjustments.ts`. **Two distinct paths, per research §5**: 5a's three team signals share the `((score − 50) / 50) × WEIGHT × relevance` formula over 004's uniform 0–100 score; 5b (bye clash) and 5c (positional run) have **no `signal_entries` row and no score** — they are computed from the owner's roster and the pick history respectively, with their own stated scaling into the same `ROUND_VALUE` currency
- [ ] T024 [P] [US1] Test `tests/engine/roster.test.ts` for FR-025 **on both sides of the boundary**: with picks remaining > unfilled mandatory slots the head ranks on value and carries a warning; with them equal the head contains only mandated positions. Also the unsatisfiable case (more unfilled slots than picks) and the complete-roster case
- [ ] T025 [US1] Implement `src/engine/roster.ts` — roster needs from the owner's picks **and keepers**, unfilled mandatory slots, and the forced-pick rule. **Nothing weights a mandated position upward before the boundary** — a kicker must never displace a starter while there is room for both
- [ ] T026 [US1] Implement `src/engine/recommend.ts` — assemble the bundle and state into a `RankedBoard`: filter to available (FR-002), value, adjust, sort, designate the head. **The sort falls through to `espn_player_id`** so ordering is total (FR-017)
- [ ] T027 [US1] Test `tests/engine/determinism.test.ts` (SC-003) — run twice over identical state, compare serialised output; and assert two players equal on every input still order deterministically
- [ ] T028 [US1] Test `tests/engine/league-currency.test.ts` (SC-004) — one pool, two scorings, demonstrably different rankings
- [ ] T029 [US1] Implement `GET /api/leagues/:id/recommendations` in `src/api/recommendations.ts` per [contracts/api.md](contracts/api.md), including the **409 `no_projections`** path that matches `/board`'s existing behaviour for the same cause
- [ ] T030 [US1] Satisfy **FR-015** by recording the on-deck obligation where it cannot be lost: a header comment in `src/api/recommendations.ts` pointing at [contracts/api.md §1a](contracts/api.md), and a line in `ROADMAP.md` under 007 stating that the draft room MUST request on 005's `on_deck` event, never on `on_the_clock`. 006 ships the endpoint; 007 ships the caller, and SC-005 is measured against that call site. During 005, `writeArchive` was built, tested, and never called — production showed zero archives after a completed draft. A capability nobody invokes is indistinguishable from one that does not exist
- [ ] T031 [US1] Contract test `tests/contract/recommendations.test.ts` — shape, ownership 404, and that `shortlist` is exactly the first `SHORTLIST_SIZE` of `entries`
- [ ] T032 [US1] Replay harness `tests/engine/replay.test.ts` walking all 72 archived picks, asserting **SC-001** (at every state, only available players are ranked) and **SC-010** (the same pick history yields the same advice, driven from the archive alone). **Assert the corpus is actually exercised** — a count of states visited — so a harness that silently walks zero picks fails loudly

**Checkpoint**: a ranked board exists and is correct. Independently valuable — this alone beats the static cheat sheet.

---

## Phase 4: User Story 2 — Show me why (P2)

**Goal**: every shortlist entry carries reasoning that reconciles to its number.

**Independent test**: for every recommendation in a replayed draft, an explanation exists, names the specific signals that applied, and removing a signal from the input changes it.

- [ ] T033 [P] [US2] Test `tests/engine/explain.test.ts` for the **reconciliation invariant** (FR-027): `finalValue − rawValue === sum(adjustments.magnitude)`, to a stated float tolerance. Construct a deliberately unreconciled explanation and assert the test fails on it — a test for an invariant must be shown to be capable of failing
- [ ] T034 [US2] Extend `tests/engine/explain.test.ts`: an entry with **no adjustments** says so plainly rather than omitting the section (US2 AS3), and `missing[]` names each unavailable input by name (FR-013)
- [ ] T035 [US2] Extend `tests/engine/explain.test.ts` for **naming and sensitivity**: when survival moved a player its reason is named in words (FR-024), not just carried as a magnitude; and **removing a signal from the input changes the explanation** (US2's Independent Test). The second is what distinguishes a real explanation from a template that always says the same thing
- [ ] T036 [US2] Implement `src/engine/explain.ts` — assemble `rawValue`, `finalValue`, `roundValue`, signed `adjustments` with named reasons, `missing`, `alternatives`, `forcedBy`
- [ ] T037 [US2] Wire explanations into the shortlist head in `src/engine/recommend.ts`; entries below the head carry value, rank and the `preferred` boolean only
- [ ] T038 [US2] Implement `GET /api/leagues/:id/recommendations/players/:playerId` in `src/api/recommendations.ts` — the on-demand explanation for a player below the head (FR-009), **404** when the player is not available
- [ ] T039 [US2] Extend `tests/engine/replay.test.ts` to assert **SC-002** (every head entry explained, naming value and alternatives) and **SC-014** (reconciliation holds for **every** entry at **every** one of the 72 states — not a sample)

**Checkpoint**: recommendations are explainable, and the explanation provably adds up.

---

## Phase 5: User Story 3 — Respect my preferences (P3)

**Goal**: the owner can build a list before draft day, and a preferred player may go somewhat early — but only somewhat.

**Independent test**: save a list, confirm it survives a reload and is invisible to another account; then rank with and without the marking and confirm a bounded move that names the preference.

- [ ] T040 [P] [US3] Test `tests/engine/preferred.test.ts` (SC-006) — the boost never exceeds `PREFERRED_CAP × ROUND_VALUE`, measured from the adjustment's **own recorded magnitude**; a player trailing the leader by more than the cap never ranks first; an empty list produces exactly the value-and-rules ranking
- [ ] T041 [US3] Implement `src/engine/preferred.ts` — a boost bounded by `PREFERRED_CAP` from `constants.ts` (research §1), emitted as a **distinctly identified adjustment** carrying the exact contributed value (FR-026), plus the `preferred` boolean on the entry so a display can badge a player below the head without fetching its explanation
- [ ] T042 [P] [US3] Implement `GET`/`PUT`/`DELETE /api/leagues/:id/preferred` in `src/api/preferred.ts` per the contract — idempotent add and remove, `on_board` flag on read
- [ ] T043 [US3] Contract test `tests/contract/preferred.test.ts` — persistence (SC-011), idempotency, and **isolation**: a request for another account's connection returns **404, not an empty list**. An empty list would confirm the connection exists
- [ ] T044 [US3] Extend `tests/contract/preferred.test.ts` for FR-021 — a preferred player absent from the board is inert: the list still loads with `on_board: false`, and the ranking is unaffected rather than crashing
- [ ] T045 [P] [US3] Add `BoardPlayer`-style client types and the three calls to `web/src/api.ts`
- [ ] T046 [US3] Build `web/src/pages/PreferredList.tsx` — **reuse `LeagueBoard.tsx:53-61`'s client-side name+position filter verbatim** rather than writing a second one. Show the current list, add, remove, and state plainly when a listed player is no longer on the board
- [ ] T047 [US3] Register the route in `web/src/App.tsx` and add an entry point from `web/src/pages/LeagueDetail.tsx`, alongside the existing "Player board" button

**Checkpoint**: the preference rule can actually fire on a real draft day.

---

## Phase 6: User Story 4 — Be honest when the inputs are poor (P4)

**Goal**: degrade visibly, never silently.

**Independent test**: withhold each input in turn and confirm the output states the degradation rather than ranking anyway.

- [ ] T048 [US4] Wire **withholding** into `src/api/recommendations.ts` from 005's existing liveness verdict — reuse the `WithholdReason` union verbatim. A withheld response is a **200 with empty `entries`**, not an error: the question was answered, and the answer is "I will not guess"
- [ ] T049 [P] [US4] Test SC-007 in `tests/contract/recommendations.test.ts` — with the draft state known-stale, no recommendation and a stated reason, in every trial
- [ ] T050 [US4] Implement `warnings[]` in `src/engine/recommend.ts` — stale board surfaced (not withheld), missing signals, unfilled mandatory slots with the pick count, and the unsatisfiable-roster case
- [ ] T051 [P] [US4] Test SC-008 in `tests/engine/degradation.test.ts` — with signals removed for a subset of players, those players are **still ranked** and their explanations name the missing input
- [ ] T052 [US4] Extend `tests/engine/degradation.test.ts`: a **stale player board is surfaced, not withheld** — the distinction the spec had to correct in US4 AS1, and the one a plausible implementation collapses into a single "stale" notion
- [ ] T053 [US4] Stamp `revision` on every `RankedBoard` in `src/engine/recommend.ts` and document the discard rule (FR-016); test in `tests/contract/recommendations.test.ts` that a board from an earlier revision is identifiable as superseded

**Checkpoint**: the engine fails safely at the moment it matters most.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T054 Assert **SC-009** in `tests/engine/replay.test.ts` by exhausting the mock — `fetchMock.activate()`, `disableNetConnect()`, full replay, `assertNoPendingInterceptors()`. Any outbound request throws
- [ ] T055 Extend `tests/engine/replay.test.ts`'s corpus to the three states the rules are most likely to get wrong: the **snake turnaround** (gap of 1, not a round), the **final pick** (no next turn), and the **late rounds** (nearly every ADP floored). A corpus that cannot express a failure proves nothing — this is the lesson from 005's structurally blind SC-010 test
- [ ] T056 **Mutation sweep** over `src/engine/`: invert each adjustment's sign, zero each weight, remove the ADP floor check, drop the total-order tiebreak, skip the pending picks in `drafted`, and **skip the keepers in `drafted`**. Every mutation must fail a test. Record any survivor and fix the test, not the mutant. **Do not use `git checkout` to revert a mutation on a file with uncommitted work** — that silently reverted real code twice during 005
- [ ] T057 [P] Verify T002's guard actually fails: temporarily give `src/engine/recommend.ts` a `Date`, and temporarily import `constants.ts` into `src/api/recommendations.ts`. Both must fail the guard — a guard that has never failed is not known to work
- [ ] T058 [P] Run the full suite (`npm test`) five consecutive times and confirm stability, matching the bar 005 was held to after its flakiness fix
- [ ] T059 Record the ratified numbers back into `ROADMAP.md` per CLAUDE.md — the five rule weights, `PREFERRED_CAP`, `ADP_COMBINED_CAP`, `SHORTLIST_SIZE` — and mark 006's remaining open question (replacement-baseline tuning) as belonging to the later tuning session
- [ ] T060 Apply `0009_preferred.sql` to production and deploy. **Confirm `wrangler whoami` reports the icloud.com account before deploying** — an alumni-org login can silently take its place

---

## Dependencies

```text
Phase 1 (Setup)
   └─▶ Phase 2 (Foundational) ── blocks everything
          ├─▶ Phase 3 (US1, P1) 🎯 MVP ── the ranked board
          │      ├─▶ Phase 4 (US2, P2) ── explanations attach to US1's entries
          │      ├─▶ Phase 5 (US3, P3) ── the boost is an adjustment on US1's value
          │      └─▶ Phase 6 (US4, P4) ── qualifies US1's output
          └─▶ Phase 7 (Polish)
```

**US2, US3 and US4 all depend on US1** and on nothing else, so once the ranked
board exists the three can proceed in parallel. US3's storage half (T042–T047)
depends only on Phase 2 and can start earlier if convenient.

## Parallel opportunities

Every `[P]` below is a genuinely distinct file. Where two tasks extend the same
test file they are sequential by design — that is why T015, T019, T022, T034,
T035, T044 and T052 carry no marker despite following a `[P]` task.

- **Phase 2**: T004, T005, T006, T007 — four independent files.
- **Phase 3**: T014, T016, T018, T021, T024 — five different test files, all
  preceding their implementations.
- **Phase 5**: T040 (engine test), T042 (API) and T045 (client types) share nothing.
- **Phase 6**: T049 and T051 are in different files.
- **Phase 7**: T057 and T058 are independent.

## Implementation strategy

**MVP is Phase 3.** A ranked board of available players in the league's own
scoring is independently valuable — it beats the static cheat sheet on its own,
and it is the thing 007 and 008 cannot start without.

Ship in story order. US2 follows immediately in practice — the plan notes they
ship together — but the phase split is real: US1 is verifiable without a single
explanation existing.

## The four traps in this feature

Named here because each is a place where a reasonable implementation is wrong.
Two were found by measuring rather than assuming; one was found by `/speckit-analyze`.

1. **The ADP floor.** 62% of the projected pool sits at ESPN's saturation floor.
   Read literally, survival would rank two-thirds of the board as safely lasting
   and be most confident in the late rounds where it is least true. **Floored ADP
   is absent ADP** (T007, T008, T018).
2. **The double count.** `slot_value` and `survival` read the same column and
   would pay a player twice for one fact. Their sum is clamped, and the clamp is
   asserted by constructing exactly that player (T019).
3. **Pending picks and keepers.** Both are players who are gone but that a naive
   `drafted` set misses — a pending pick has a real player and an unconfirmed
   ordinal; a keeper never appears as a pick at all in some leagues. Either one
   recommends a player nobody can take (T010, T012, T013, mutation-checked in T056).
4. **Two of the five adjustments have no signal.** Bye clash and positional run
   are computed in-engine from the roster and the pick history; they have no
   `signal_entries` row and no 0–100 score, so the shared signal formula does not
   apply to them (T022, T023, research §5).
