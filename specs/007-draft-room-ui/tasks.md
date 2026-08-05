---

description: "Task list for 007-draft-room-ui"
---

# Tasks: Draft Room UI (007)

**Input**: Design documents from `specs/007-draft-room-ui/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/ui.md](contracts/ui.md), [quickstart.md](quickstart.md) — and the deployed 001–006 + 010 build.

**Tests**: requested, and first-class. SC-001 is the reason this feature exists
and FR-024 requires it be **measured offline**, which is only possible because
the logic is a pure reducer. For the reducer the tests come **before** the
implementation, as they did for 005's `reconcile.ts` and 006's `recommend.ts`.

**Mutation testing is the acceptance bar**, not line coverage. 005 shipped two
tests that survived their own mutations; 006's sweep killed all twelve only
because each was written against a rule whose corruption would otherwise be
invisible in the output.

## Format: `[ID] [P?] [Story] Description`

- **[P]** — parallelisable: a **different file** from every other task that could
  run alongside it, and no dependency on an incomplete task
- **[US1]…[US4]** — the user story a task serves; absent for Setup, Foundational and Polish

## Path Conventions

React SPA against the existing Worker API: `web/src/` (app), `tests/room/` (new,
node project). **No server code, no migration, no new dependency.**

## Prerequisites already satisfied

Do **not** rebuild these.

- **The socket client** — 005's `web/src/lib/draftSocket.ts` already does
  exponential backoff, cursor discipline (discard `seq <= cursor`, resync only on
  a true forward gap), epoch-as-reset, and a polling fallback after three
  failures. Extend it only if something is genuinely missing.
- **The design** — ratified 2026-08-02 and already ported to
  `web/src/pages/DraftBoard.tsx` (301 lines) at `/design/draft`. Two columns:
  full grid + a fixed **318px** rail. Do **not** reopen it.
- **The detail-panel pattern** — `web/src/components/PlayerDetailSheet.tsx`.
- **The preferred list** — 006 ships the page and its endpoints. Link, never rebuild.
- **The engine** — 006 returns the ranked board, per-adjustment signed magnitudes
  with named reasons, `preferred`, `forcedBy`, and an on-demand explanation.
- **The corpus** — `tests/fixtures/tap/replay-full.jsonl`, 72 real frames each
  carrying a true `observedAt`, verified during 005 against an independent oracle.

---

## Phase 1: Setup

- [X] T001 Create `web/src/lib/draftRoom.ts`, `web/src/lib/draftRoomSelectors.ts` and the test directory `tests/room/`, per plan.md's Structure Decision
- [X] T002 Wire `tests/room/**` into the **node** project: add `"tests/room/**/*.test.ts"` to the `include` in `vitest.config.ts`, **and** add `"tests/room/**"` to the `exclude` in `vitest.workers.config.ts`. Both edits are required — the workers project's include is `tests/**/*.test.ts`, so without the exclude these run in the workers pool too, where they fail exactly as the tap tests would. 005's config comments record why that exclude list exists
- [X] T003 Add a **purity guard** in `tests/room/purity.test.ts` that reads `web/src/lib/draftRoom.ts` and `web/src/lib/draftRoomSelectors.ts` and fails on any `fetch(`, `new Date`, `Date.now`, `Math.random`, `document`, `window`, or import from `react`. Strip comments before scanning so the guard survives its own documentation — 006's equivalent guard needed exactly that. Assert the file set is non-empty, or the guard passes vacuously forever

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user story work begins until this phase is complete.**

- [X] T004 [P] Define the reducer's shapes in `web/src/lib/draftRoom.ts` — `RoomState`, `RoomInput`, `Effect`, `Completion`, `Pick` — exactly as specified in [data-model.md](data-model.md). Note `picksUntilMyTurn: number | null` where **null means unknown, never zero**: 005 and 006 have both been bitten by a zero standing in for an absence
- [X] T005 [P] Extend `web/src/api.ts` with the recommendation types and the two calls — `getRecommendations(id)` and `getRecommendationForPlayer(id, playerId)` — mirroring 006's response shape verbatim, including `withheld`, `forced`, `warnings`, `round_value`, and per-adjustment `magnitude` / `direction` / `reason`
- [X] T006 Implement the reducer skeleton `reduce(state, input, at)` in `web/src/lib/draftRoom.ts`: **`at` is a parameter, never a clock read**, and effects are **returned, never performed**. That second property is what makes SC-001 assertable — the test needs to see the *decision* to fetch, not its side effect
- [X] T007 Test `tests/room/reduce.test.ts` for the frame contract: a snapshot is authoritative and adopts epoch + cursor wholesale; a frame at or below `cursor` produces **no state change and no effects**; only a true **forward gap** requests a snapshot; an **epoch change discards state** rather than merging. Duplicates are expected — treating one as a gap causes a resync storm at exactly the busiest moment
- [X] T008 [P] Test `tests/room/selectors-grid.test.ts` for the **structural selectors**: `boardGrid()` places cells by round and pick, marks the owner's column and the current pick, and renders an **unknown player id as a placeholder rather than throwing** (010's lesson — negative D/ST ids around −16000 are legitimate); `rosterView()` reports the owner's players and takes unfilled slots from **006's warnings**, never a local recomputation
- [X] T009 Implement `boardGrid()` and `rosterView()` in `web/src/lib/draftRoomSelectors.ts`. **These are foundational, not US2's**: US3's grid and US4's completed summary both need them, and an earlier version of this plan put the whole selector module in US2 while claiming US2/US3/US4 were mutually independent — which was false

---

## Phase 3: User Story 1 — Tell me who to take, before the clock starts (P1) 🎯 MVP

**Goal**: a current recommendation with reasoning is on screen whenever the owner's turn begins.

**Independent test**: replay the archived draft and confirm every one of the owner's turns had a recommendation current before the turn began, at every modelled latency.

- [X] T010 [P] [US1] Test the **refresh policy** in `tests/room/refresh.test.ts` (research §3): a pick with no request in flight emits `fetchRecommendation`; a pick **while one is in flight** emits nothing but sets `dirty`; exactly **one** further fetch is emitted when the outstanding request returns — not one per pick buffered. Measured autodraft hit ~1 pick/second, so a per-pick fan-out is the failure this policy exists to prevent
- [X] T011 [US1] Extend `tests/room/refresh.test.ts`: a response whose `revision` no longer matches state is **discarded, not rendered** (FR-016); a **withheld** response (200 with empty entries) is stored and surfaced, and is **not** retried as a failure
- [X] T012 [US1] Implement the refresh policy in `web/src/lib/draftRoom.ts` — `inFlight` / `dirty`, per research §3. Bounded by round-trip time rather than pick rate, and it must degrade in the right direction: a slow server produces **fewer** requests, never a queue
- [X] T013 [US1] Implement **pick application** in `web/src/lib/draftRoom.ts`: a `pick_made` event is applied additively (it carries `overall`, `teamId`, `playerId` — enough to place a cell). **Do NOT reimplement 005's reconciler**: anything needing judgement — ordinals, ledger merges, pending vs confirmed — triggers a snapshot re-read instead. The client displays; the server decides
- [X] T014 [US1] Implement `myTurnState` (`idle` / `on_deck` / `on_the_clock`) in `web/src/lib/draftRoom.ts`, driven by 005's turn events. These drive the **visual state only** (FR-004) — they are not fetch triggers, which is what dissolves the snake turnaround as a special case
- [X] T015 [US1] Build the **replay harness** `tests/room/replay-timing.test.ts`: drive the reducer with `tests/fixtures/tap/replay-full.jsonl`, advancing a **virtual clock** to each frame's real `observedAt`. `readyAt` = when the reducer emitted the fetch **plus a modelled round trip** — without that latency every turn passes by construction
- [X] T016 [US1] **Sweep the round trip** in `tests/room/replay-timing.test.ts` — 200, 500, 800, 1200 and 2000 ms — and assert SC-001 holds at every one. A single chosen constant would be invented, and would rig the result green or red; asserting insensitivity is what earns the right to have a constant, exactly as 006 did for `FLOOR_DENSITY_RATIO`
- [X] T017 [US1] Assert **SC-001 as all 12 turns**, not "95%", in `tests/room/replay-timing.test.ts`. The corpus is 6 teams × 12 rounds, so the owner has exactly 12 turns and 95% of 12 is 11.4 — a bar no integer count expresses, and one an implementer could read as 11/12 while shipping a real miss
- [X] T018 [US1] Assert in `tests/room/replay-timing.test.ts` that the harness **actually ran** — a minimum count of turns evaluated and frames applied. A replay that silently walks zero turns looks identical to one that walks them all; 005 shipped an SC-010 test that passed while proving exactly nothing
- [X] T019 [US1] Assert **SC-009** separately in `tests/room/replay-timing.test.ts` — the owner's **second consecutive pick** at a snake turnaround, in every such turn of the corpus. This is the case the inherited obligation could not express, and where a regression appears first: it is only ready because the reducer refreshed on the pick before
- [X] T020 [US1] Assert **SC-003** in `tests/room/replay-timing.test.ts` — each frame's recorded arrival to its placement on the grid, within 2 s p95 and 10 s always. The harness already holds both timestamps, so this is a second read of collected data rather than a second harness
- [X] T021 [US1] Build `web/src/pages/DraftRoom.tsx` as a **rendering shell** — it holds the reducer's state, performs the effects the reducer returns, and makes **no decisions**. Wire `connectDraftStream` from `web/src/lib/draftSocket.ts` as the frame source
- [X] T022 [US1] Add the **preferred-list link** to the header in `web/src/pages/DraftRoom.tsx` (FR-018), pointing at 006's page. The ratified design already draws this button — see `web/src/pages/DraftBoard.tsx:168`. Link only; **never** reimplement list management
- [X] T023 [US1] Register the route in `web/src/App.tsx` and add an entry point from `web/src/pages/LeagueDetail.tsx`, alongside the existing "Player board" and "Preferred players" buttons

**Checkpoint**: a recommendation is current when the owner's turn begins, and it is proven offline rather than promised.

---

## Phase 4: User Story 2 — Show me the reasoning, not a name (P2)

**Goal**: no recommended player is ever a bare name, and the full breakdown is one interaction away.

**Independent test**: every rail entry shows a value and a reason with no interaction; the full breakdown opens in one.

- [X] T024 [P] [US2] Test `tests/room/selectors-rail.test.ts` for the **headline** rule (research §6): it is the adjustment with the **largest absolute magnitude**, using 006's own phrasing; `forcedBy` **overrides** it entirely when the pick is forced; and with **no adjustments** it is a plain "no rule applied" (FR-008) — **never empty**, because an empty headline is a bare name
- [X] T025 [US2] Extend `tests/room/selectors-rail.test.ts` for the **preferred badge** (FR-007): a preferred player carries the flag and the exact value the preference contributed, taken from 006's fields rather than recomputed, and it is present on entries **below** the shortlist head too
- [X] T026 [US2] Implement `railEntries()` in `web/src/lib/draftRoomSelectors.ts` — the one selector that belongs to this story, since it applies the headline rule
- [X] T027 [US2] Render the rail in `web/src/pages/DraftRoom.tsx` at the ratified **318px**: value plus headline reason per entry, visible with **no interaction**, and the preferred badge
- [X] T028 [US2] Build `web/src/components/RecommendationPanel.tsx` — the full breakdown (every adjustment with direction and magnitude, missing inputs, alternatives), modelled on `web/src/components/PlayerDetailSheet.tsx` so there is one interaction pattern rather than two
- [X] T029 [US2] Wire the **on-demand explanation** for a player below the shortlist (FR-009) into `web/src/components/RecommendationPanel.tsx`, via 006's `/recommendations/players/:playerId`

**Checkpoint**: Constitution VII holds at a glance, not after a tap.

---

## Phase 5: User Story 3 — Show me the draft as it happens (P3)

**Goal**: the board, the roster, and the turn state, live.

**Independent test**: a pick lands and appears without a refresh; the roster and turn indicator track it.

- [X] T030 [US3] Render the **draft board grid** in `web/src/pages/DraftRoom.tsx` from `boardGrid()`, matching the ratified layout in `web/src/pages/DraftBoard.tsx`
- [X] T031 [US3] Render the **owner's roster and remaining needs** in `web/src/pages/DraftRoom.tsx`, from `rosterView()`
- [X] T032 [US3] Render **picks-until-my-turn** in `web/src/pages/DraftRoom.tsx`. **Null renders as unknown, never as "0"** — a zero here reads as "you are on the clock" and would be actively misleading
- [X] T033 [US3] Implement the **pre-draft state** in `web/src/pages/DraftRoom.tsx`: the countdown to the scheduled start, and the draft order once ESPN publishes it. `order === null` MUST say "not published yet" rather than invent one (FR-017)
- [X] T034 [US3] Implement **FR-021's bound** in `web/src/lib/draftRoom.ts` — raw frames are discarded once applied; only materialised picks are retained
- [X] T035 [US3] Assert **SC-008** in `tests/room/reduce.test.ts`: drive the reducer with far more frames than a draft contains — including duplicates and re-sent snapshots — and confirm retained state grows with **pick count, not frame count**. The old wording was "usable without degradation", which named no measurable thing

**Checkpoint**: the screen shows the draft, not just the advice.

---

## Phase 6: User Story 4 — Survive draft day going wrong (P4)

**Goal**: recover silently where possible; say so plainly where not.

**Independent test**: reload and reconnect recover full state with no missing or duplicated picks; a lapsed tap is stated, not hidden.

- [X] T036 [P] [US4] Test `tests/room/recovery.test.ts` for **reload** (SC-004): replay from cold mid-draft and assert every pick returns exactly once — zero missing, zero duplicated
- [X] T037 [US4] Extend `tests/room/recovery.test.ts` for a **connection gap** (SC-005): withhold frames, then resume; the missing picks arrive exactly once, and a duplicate frame after resume changes nothing
- [X] T038 [US4] Extend `tests/room/recovery.test.ts` for an **epoch change**: state is discarded and re-read, never merged. Carrying a stale cursor across a rebuild would silently skip a reconstructed draft
- [X] T039 [P] [US4] Test `tests/room/completion.test.ts` (SC-011): the corpus runs to completion **by the signal alone**, and **by the pick count alone** — each must reach the completed state independently. Neither may be load-bearing, because the signal has never fired in production and the pick count depends on a draft length that has been wrong before
- [X] T040 [US4] Extend `tests/room/completion.test.ts`: when the two routes **disagree**, the screen still completes and the divergence is **recorded and surfaced**, not silently resolved (FR-022b). That divergence is the first real evidence anyone will have about which route to trust
- [X] T041 [US4] Implement both **completion routes** and `Completion` in `web/src/lib/draftRoom.ts` per research §5
- [X] T042 [US4] Render the **completed state** in `web/src/pages/DraftRoom.tsx` — a final roster summary, recommendations stopped, and the divergence noted if there was one
- [X] T043 [US4] Render **withholding** in `web/src/pages/DraftRoom.tsx` from 005's verdict — the reason **and the remedy**, reusing the copy already in `web/src/pages/DraftDiagnostics.tsx` rather than writing a second vocabulary
- [X] T044 [US4] Render **reachability** in `web/src/pages/DraftRoom.tsx` as visibly distinct from withholding. These are different failures with different remedies — "wait" versus "go check the tap's tab" — and during a live draft a wrong diagnosis costs a pick
- [X] T045 [US4] Make a **stale screen look stale** in `web/src/pages/DraftRoom.tsx` (FR-015): when reconnecting or polling, the screen must not continue to look live

**Checkpoint**: the screen fails visibly, which is the only acceptable way to fail during a draft.

---

## Phase 7: Polish & Cross-Cutting

- [X] T046 Implement the three **visual states** in `web/src/pages/DraftRoom.tsx` per research §7 — idle, on deck, on the clock — using tokens already in `web/src/styles.css`. No new colours, and no animation that would pull the eye during someone else's pick. Review the copy against **FR-023a**: nothing may imply the screen will reach an owner who is looking elsewhere
- [X] T047 Extend `tests/room/purity.test.ts` with the **FR-020 read-only guard**: no file under `web/src/pages/DraftRoom.tsx`, `web/src/components/RecommendationPanel.tsx` or `web/src/lib/draftRoom*.ts` issues a non-`GET` request. Constitution VI is a MUST, and "the code happens not to contain a write" is a coincidence waiting for a convenience helper — 006 asserts its equivalent structurally for the same reason
- [X] T048 Verify **SC-010** for `web/src/pages/DraftRoom.tsx` in the browser: the three states are distinguishable **from a screenshot, without reading text**. Capture all three and compare
- [X] T049 **Amend 006's `specs/006-recommendation-engine/contracts/api.md` §1a** — replace "MUST issue the request on `on_deck`, not on `on_the_clock`" with the outcome-based obligation written out in [contracts/ui.md](contracts/ui.md) §3. Left as-is it governs an implementation that disagrees with it, and would push a future consumer toward the design 007 rejected
- [X] T050 **Mutation sweep** over `web/src/lib/draftRoom.ts` and `web/src/lib/draftRoomSelectors.ts`: invert the cursor comparison, remove the epoch-reset branch, drop the `dirty` flag, ignore `revision` on a response, make the headline pick the *smallest* magnitude, and remove one completion route. Every mutation must fail a test. Record any survivor and fix the **test**, not the mutant. **Do not use `git checkout` to revert a mutation on a file with uncommitted work** — that silently reverted real code twice during 005
- [X] T051 Verify the guards (T003, T047) actually fail: temporarily add a `Date.now()` to `web/src/lib/draftRoom.ts`, and a `POST` to `web/src/pages/DraftRoom.tsx`. Both must fail. A guard that has never failed is not known to work
- [X] T052 [P] Run the full suite (`npm test`) five consecutive times and confirm stability, matching the bar 005 and 006 were held to
- [X] T053 Verify `web/src/pages/DraftRoom.tsx` against `web/src/pages/DraftBoard.tsx` (`/design/draft`) in the browser — visually indistinguishable apart from carrying real state, confirming FR-019 held and the design was not quietly reopened
- [X] T054 Record 007's ratified decisions in `ROADMAP.md` per CLAUDE.md, and note that 006's contract has been corrected (T049)
- [ ] T055 Deploy `web/` and the Worker via `npm run deploy`. **Confirm `wrangler whoami` reports the icloud.com account before deploying** — an alumni-org login can silently take its place. No migration this time: 007 persists nothing

---

## Dependencies

```text
Phase 1 (Setup)
   └─▶ Phase 2 (Foundational) ── reducer shapes, frame contract, AND the
          │                       structural selectors (boardGrid, rosterView)
          ├─▶ Phase 3 (US1, P1) 🎯 MVP ── a current recommendation, proven offline
          │      ├─▶ Phase 4 (US2, P2) ── railEntries() + the reasoning UI
          │      ├─▶ Phase 5 (US3, P3) ── the board around it
          │      └─▶ Phase 6 (US4, P4) ── recovery and honest failure
          └─▶ Phase 7 (Polish)
```

**US2, US3 and US4 depend on US1 and on nothing else** — and that is true only
because T009 puts `boardGrid()` and `rosterView()` in Foundational. An earlier
version of this list built the whole selector module in US2 while claiming the
same independence, which was false: US3's grid (T030), US3's roster (T031) and
US4's completed summary (T042) all need those selectors. `/speckit-analyze` found
it before anyone tried to start US3 in parallel and hit a missing module.

US4's recovery tests (T036–T038) depend only on Phase 2 and can start earlier if
convenient.

## Parallel opportunities

Every `[P]` is a genuinely distinct file. Where two tasks extend the same test
file they are sequential by design — that is why T011, T025, T037, T038 and T040
carry no marker despite following a `[P]` task.

- **Phase 2**: T004, T005 and T008 are three different files.
- **Phase 3**: T010 (`refresh.test.ts`) is independent of T015's harness file.
- **Phase 4 / 5**: the selector tests are now **split by concern** —
  `selectors-grid.test.ts` (Foundational) and `selectors-rail.test.ts` (US2) — so
  they no longer collide across stories, which is what forced T024 to be
  sequential in the previous version.
- **Phase 6**: T036 and T039 are different files.
- **Phase 7**: only T052 is marked. T050, T051 and T053 each mutate or run the
  whole suite, so none may race the others.

## The five traps in this feature

1. **A second reducer in the browser.** The temptation is to reconcile picks
   client-side for speed. 005 fought hard for that logic — including a bug where
   the reducer silently *deleted* picks — and a second copy would drift
   invisibly. Apply events additively; re-read the snapshot for anything needing
   judgement (T013).
2. **Request-per-pick.** FR-003 says refresh on every pick, and measured
   autodraft ran ~1 pick/second. Without the in-flight/dirty policy that is 60
   requests a minute at the busiest moment of the draft (T010, T012).
3. **A DOM creeping into the reducer.** The moment `draftRoom.ts` touches
   `document` or `Date.now()`, FR-024's offline replay stops working and this
   feature needs a test stack it currently does not (T003, T051).
4. **Trusting one completion route.** Neither has production evidence. Each is
   tested alone, and a disagreement is surfaced rather than resolved (T039, T040).
5. **A green replay that proves nothing.** The most dangerous failure here,
   because it comes with a passing test attached. An optimistic round trip makes
   every turn pass by construction; "95%" of a 12-turn corpus reads as 11 of 12
   and hides a real miss. The round trip is **swept** 200–2000 ms (T016) and the
   bar is **all 12 turns** (T017). Both were found by `/speckit-analyze`, not by
   running anything.
