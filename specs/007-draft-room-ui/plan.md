# Implementation Plan: Draft Room UI

**Branch**: `007-draft-room-ui` | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-draft-room-ui/spec.md`

## Summary

The screen open during the draft. Everything it renders already exists and is
deployed: 005 streams the picks, turn events and the withholding verdict; 006
returns a ranked board with per-adjustment reasoning and the preferred badge; the
visual design was ratified in August and already ships as a mock at
`/design/draft`. This feature makes that screen real.

**One decision shapes the whole plan.** All draft-room logic goes into a **pure
reducer** — `web/src/lib/draftRoom.ts`, `reduce(state, input, at) → {state,
effects}` — with React rendering its output and deciding nothing. That is the
same move 005 made with `reconcile.ts` and 006 with `recommend.ts`, and it is
what lets FR-024's offline timing measurement happen **with no DOM, no
component-testing library, and no new dependencies at all**.

The alternative — jsdom plus a component-testing stack plus a fourth vitest
project — would have added a dependency set whose only job was to make a timing
claim checkable, and it would have measured React's render rather than the thing
that can actually fail: *deciding to fetch too late*.

**Net new surface: one library module, one page, one panel.** No endpoint, no
table, no migration, no dependency.

## Technical Context

**Language/Version**: TypeScript 5, React 18, `strict`.

**Primary Dependencies**: **none new.** React, react-router-dom, Vite and Vitest
are already present. The reducer imports nothing.

**Storage**: none. 007 persists nothing — no table, no column, no migration.
State is in-memory in the browser, derived from 005's stream and 006's board.

**Testing**: Vitest. Reducer and replay tests run in the **existing `node`
project** (`tests/room/**`), because research §1 removed the need for a DOM.
Mutation testing remains the acceptance bar, as it was for 005, 006 and 010.

**Target Platform**: iPad and desktop browsers, per the constitution's delivery
target. Phone is explicitly out of scope.

**Project Type**: SPA page against an existing Worker API.

**Performance Goals**: SC-001 — a recommendation current before the owner's turn
in ≥95% of turns, measured offline over the real corpus. SC-003 — a pick visible
within 2 s p95, which 005's delivery already meets (measured p95 0.223 s).

**Constraints**: at most one recommendation request in flight (measured autodraft
runs hit ~1 pick/second); the reducer takes `at` as a parameter and never reads a
clock; no reconciliation client-side.

**Scale/Scope**: a 12-team × 15-round draft is 180 picks — bounded by
construction, so FR-021 costs nothing at the grid. Raw frames are discarded after
application; only materialised picks are retained.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — see below.*

| Principle | Verdict | How |
|---|---|---|
| **I. Spec-First** | ✅ | Spec written and clarified (5 questions, 2026-08-05). This plan follows it. |
| **II. Any-League by Design** | ✅ | Nothing league-specific. Team count, round count, roster shape and draft order all arrive from 005/006; `order === null` renders as "not published" rather than inventing one. |
| **III. League's Currency** | ✅ | The screen renders 006's numbers verbatim and computes no value of its own. The headline reason is a `reduce` over adjustments 006 already produced — a selection, never a recomputation. |
| **IV. Rules Are Code** | ✅ | No rule logic here at all, and no setting. The screen cannot alter a recommendation, only display it. |
| **V. Draft Day Is Unforgiving** | ✅ | The principle this feature exists to satisfy. Refresh-on-every-pick makes readiness structural rather than dependent on catching one moment (FR-003a); reload and reconnect recover full state; the polling fallback after three failures is already built. |
| **VI. Recommend, Never Act** | ✅ | Read-only. No write path to ESPN exists from this screen, and none is added. |
| **VII. Explainable** | ✅ | FR-006 requires value and the strongest reason visible with **no interaction**; the full breakdown is one interaction away. `headline` is never empty — that is what makes "no bare names" true at a glance rather than after a tap. |
| **VIII. Simplicity First** | ✅ | No new dependency, no new endpoint, no new table, no new vitest project. The pure reducer is what buys all four. |

**No violations. Complexity Tracking is empty.**

Two things worth naming rather than burying:

- **This feature ships a second screen** (the draft room) alongside 006's
  preferred-list page. That is 007's whole purpose, not scope creep.
- **The reducer duplicates nothing.** It applies pick events additively for
  display; anything requiring judgement — ordinals, ledger merges, pending vs
  confirmed — is re-read from 005's snapshot. The client displays; the server
  decides.

## Project Structure

### Documentation (this feature)

```text
specs/007-draft-room-ui/
├── plan.md              # This file
├── research.md          # Phase 0 — where the logic lives, and why no DOM
├── data-model.md        # Phase 1 — the reducer's state; nothing persisted
├── quickstart.md        # Phase 1 — five checks, none needing a live draft
├── contracts/ui.md      # Phase 1 — the reducer contract, and 006's correction
├── checklists/
│   └── requirements.md  # 16/16
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
web/src/
├── lib/
│   ├── draftRoom.ts             # NEW — the pure reducer. No fetch, no Date, no DOM.
│   ├── draftRoomSelectors.ts    # NEW — RoomState → BoardGrid / RailEntry / RosterView
│   └── draftSocket.ts           # EXISTS (005) — backoff, cursor, epoch, polling fallback
├── pages/
│   ├── DraftRoom.tsx            # NEW — renders the reducer's state; decides nothing
│   ├── DraftBoard.tsx           # EXISTS — the ratified mock, kept as the reference
│   └── DraftDiagnostics.tsx     # EXISTS (005) — superseded, retained for diagnosis
├── components/
│   ├── RecommendationPanel.tsx  # NEW — the full breakdown, modelled on PlayerDetailSheet
│   └── PlayerDetailSheet.tsx    # EXISTS — the interaction pattern being reused
└── api.ts                       # EXTEND — recommendation types + the two GETs

tests/room/                      # NEW — node project, no DOM
├── reduce.test.ts               #   frames, duplicates, epoch, revision
├── replay-timing.test.ts        #   SC-001 + SC-009 over the real 72-frame corpus
├── recovery.test.ts             #   SC-004 / SC-005 — reload, gap, epoch change
├── completion.test.ts           #   SC-011 — each route alone, and in conflict
└── selectors.test.ts            #   headline choice, forced picks, preferred badge

specs/006-recommendation-engine/
└── contracts/api.md             # AMEND — §1a's obligation, restated as an outcome

vitest.config.ts                 # EXTEND — node project includes tests/room/**
vitest.workers.config.ts         # EXTEND — exclude tests/room/**, as it already
                                 #   excludes tests/tap/** and tests/draft/**
```

**Two config lines, not zero.** The node project currently includes only
`tests/tap/**`, and the workers project's include is `tests/**/*.test.ts` with an
explicit exclude list. Without both edits the room tests would run in the workers
pool as well — where they would fail for the same reason the tap tests do. 005's
config comments say exactly this; the exclude list exists because it was learned
the hard way.

**Structure Decision**: the reducer/selector split mirrors what worked twice
before. `draftRoom.ts` holds every decision and is testable with nothing but a
number for the clock; `draftRoomSelectors.ts` turns state into exactly what the
ratified layout needs; `DraftRoom.tsx` is a rendering shell. A structural guard
enforces that the reducer imports no platform — the same technique 006 uses on
`src/engine/`, which was proven capable of failing three ways before being
trusted.

## Phase 0 — Research

Complete. See [research.md](research.md). Eight decisions:

| § | Resolution |
|---|---|
| 1 | Pure reducer; React decides nothing — **this is what removes the DOM test stack** |
| 2 | Apply events additively; re-read the snapshot only on revision, epoch, gap, first load |
| 3 | One request in flight + one trailing — bounded by round-trip, not pick rate |
| 4 | SC-001 measured on a **virtual clock** over the real corpus, no DOM |
| 5 | Completion by **either** route; divergence surfaced, not resolved |
| 6 | Headline = largest-magnitude adjustment; `forcedBy` overrides it |
| 7 | Three token-based visual states, verifiable from a screenshot |
| 8 | An explicit list of what this feature does **not** build |

Two deserve highlighting:

**§3 — refresh-per-pick is not request-per-pick.** Measured autodraft produced
~1 pick/second. One in-flight request with a trailing refresh collapses a burst
into two requests while keeping FR-003's guarantee, and degrades in the right
direction: a slow server produces *fewer* requests, not a queue of them.

**§5 — neither completion route is trusted alone.** The completion signal has
never fired in production, and the pick count depends on a draft length that has
been wrong before. They fail differently, so requiring either is a real
improvement — and surfacing a disagreement preserves the only evidence the next
real draft will produce about which to trust.

## Phase 1 — Design & Contracts

Complete.

- **[data-model.md](data-model.md)** — `RoomState`, `RoomInput`, `Effect`,
  `Completion`, and the derived `BoardGrid` / `RailEntry` / `RosterView`.
  Nothing persisted; no migration.
- **[contracts/ui.md](contracts/ui.md)** — the reducer's four contractual
  properties, what 007 owes 005 (cursor discipline, epoch reset, and
  reachability ≠ picks arriving), and **the corrected wording for 006's §1a**.
- **[quickstart.md](quickstart.md)** — five checks, none needing a live draft,
  plus an explicit statement of what still cannot be verified.

### Post-Design Constitution Re-check

Re-evaluated against the finished design. **Still passing, no new violations.**

Three things the design phase changed rather than confirmed:

1. **Principle VIII got much stronger.** The first sketch assumed a DOM test
   stack for FR-024. Moving the logic into a pure reducer removed two
   dependencies, a vitest project, and a whole category of flakiness — and made
   the test measure the thing that can actually fail.
2. **Principle VII got a specific form.** "Explainable" became *the headline
   reason is never empty and needs no interaction*, with the full breakdown one
   tap away. That is checkable; "shows reasoning" was not.
3. **Principle V stopped depending on timing.** Refresh-per-pick makes readiness
   structural. The inherited obligation asked the screen to catch one moment
   correctly, twelve times per draft, at exactly the points where that moment
   sometimes does not exist.

## Complexity Tracking

No constitutional violations. Table intentionally empty.

## Risks

| Risk | Why it is real | Mitigation |
|---|---|---|
| **Completion has never fired in production** | `draft_archives` holds zero rows; the only live test had a draft length of 0, making completion unreachable | Two independent routes (research §5), each tested alone, with divergence surfaced rather than resolved |
| **SC-001 is measured against a model, not a browser** | The harness times the *decision to fetch* plus a modelled round trip — not React's paint | Deliberate: the decision is where it can fail. The residual risk is render cost, bounded by a 180-cell grid, and worth checking once on a real iPad |
| **The rail's headline may pick a dull reason** | "Largest magnitude" is mechanical; the most *interesting* reason may not be the biggest | Mechanical is the point — a selection over 006's own output, not a judgement. Revisit only with evidence from a real draft |
| **`DraftDiagnostics` and `DraftRoom` overlap** | Two pages reading the same stream can drift | Diagnostics is retained deliberately as a *diagnostic*, not a second product surface. If it drifts, it is the one that gets deleted |
| **006's contract is still wrong on disk** | It governs an implementation that disagrees with it, and would misdirect a future consumer | Amending it is a task in this feature, not a note |
