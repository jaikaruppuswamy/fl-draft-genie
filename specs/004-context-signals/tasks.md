# Tasks: Context Signals

**Input**: Design documents from `/specs/004-context-signals/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/api.md, quickstart.md — and the deployed 002/003 build (signals
derive from the projection pipeline).

**Tests**: Included — hand-computed signal oracles are the SC-002/FR-002
acceptance tests, per the project's established pattern. Tests first per
story.

**Organization**: US1 (signals visible in detail), US2 (lockstep freshness),
US3 (uniform shape contract).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Migration `migrations/0004_signals.sql`: `signal_entries` table per data-model.md (kind CHECK, PK(kind, pro_team_id)); apply locally
- [ ] T002 [P] Extend `tests/fixtures/espn/proteams.json` with `proGamesByScoringPeriod` schedule data for the fixture teams (enough weeks to hand-compute SoS incl. weeks 15–17 for the playoff weighting), and add a valid + an invalid (31-team) curated O-line fixture under `tests/fixtures/signals/`

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T003 Extend `src/projections/espnSource.ts` `fetchProTeams` to also parse `proGamesByScoringPeriod` → per-team `(week, opponentProTeamId)` list (verify field shape against the live public endpoint first, per established practice); extend `tests/unit/espnSource.test.ts`
- [ ] T004 [P] Create `src/signals/reference.ts`: fixed reference scoring maps (offense standard+0.5 PPR map; D/ST map) as code constants with a short doc comment stating they exist only for cross-team signal computation (constitution III guard)
- [ ] T005 [P] Create `src/db/signals.ts`: per-kind atomic replace (delete+chunked insert in one batch, tier_entries pattern) and `getSignalMaps(db)` → per-kind Map(pro_team_id → {raw, score, rank, provenance, computed_at})

## Phase 3: User Story 1 - Signals in the player detail (Priority: P1) 🎯 MVP

**Goal**: Offense/SoS/O-line ranks + bye visible with labels on every player detail.

**Independent Test**: Quickstart scenarios 1–4 — signals exist for 32 teams, plausibility spot-checks pass, detail renders them, SoS hand-check matches.

### Tests for User Story 1

- [ ] T006 [P] [US1] Signal oracle unit tests in `tests/unit/signals.test.ts`: hand-computed offense totals and SoS weighted means from the extended fixtures (weeks 15–17 doubled, bye omitted), normalization orientation (100 = favorable), rank ties (shared better rank, stable by team id), label thresholds, teamless/empty-team edge cases
- [ ] T007 [P] [US1] Contract tests in `tests/contract/detail-signals.test.ts`: detail response carries the `signals` block per contracts/api.md; free agent → all nulls; missing curated team → oline null; schedule absent → sos null; board list response unchanged
- [ ] T008 [P] [US1] Curated-file validation unit tests in `tests/unit/curated.test.ts`: valid 32-team file loads; 31-team file rejected loudly; non-permutation ranks rejected; unresolvable abbrev rejected (SC-005)

### Implementation for User Story 1

- [ ] T009 [US1] Implement `src/signals/compute.ts`: reference-score offense per team (QB/RB/WR/TE only), D/ST defensive strength, SoS weighted mean over parsed schedule (playoff ×2, bye omitted, rank 1 = easiest), min-max normalize 0–100 (100 = favorable), deterministic tie ranks, plain-language labeler (thresholds in code) (depends on T003/T004, tests T006 failing first)
- [ ] T010 [US1] Implement `src/signals/curated.ts` (oline file loader + completeness validation per data-model.md) and seed `src/signals/data/oline-2026.json` from PFF's current preseason OL rankings (web lookup; if unreachable, mark `"provisional": true` with honest provenance for owner review)
- [ ] T011 [US1] Implement `computeSignals(env, now)` orchestrator in `src/signals/compute.ts`: derive offense+sos from the serving projection set, load curated oline, write each kind via `src/db/signals.ts` — per-kind all-or-nothing, never throws (FR-008)
- [ ] T012 [US1] Extend the detail endpoint in `src/api/board.ts` with the `signals` block (join player → pro_team → signal maps + bye from pro_teams; nulls per contract) (depends on T009–T011)
- [ ] T013 [US1] Add the Signals section to `web/src/components/PlayerDetailSheet.tsx` (four labeled rows with rank + label, dashes for nulls, Organic styling) and extend `web/src/api.ts` PlayerDetail type

**Checkpoint**: MVP — every player detail explains its context.

## Phase 4: User Story 2 - Lockstep freshness (Priority: P2)

**Goal**: Signals recompute with every projection refresh; failures keep last-good.

**Independent Test**: Quickstart scenarios 1/6 — computed_at tracks the serving set; failed refresh leaves signals serving.

- [ ] T014 [P] [US2] Integration tests in `tests/integration/signals-freshness.test.ts` (fake clocks): after a projection refresh, derived kinds' computed_at equals the new serving set's fetched_at (SC-004); failed projection refresh → signals untouched; empty signals table on a tick → computed even without a projection refresh
- [ ] T015 [US2] Wire `computeSignals` into `src/sync/predraft.ts` scheduled maintenance (after projection refresh / when signals empty) and `src/api/projections.ts` on-demand refresh, mirroring the tier ingest sites (depends on T011)

## Phase 5: User Story 3 - Uniform shape (Priority: P3)

**Goal**: Every kind readable identically; provenance always populated.

**Independent Test**: Enumerating stored signals shows one shape across kinds.

- [ ] T016 [US3] Uniformity contract test in `tests/contract/signals-shape.test.ts`: all three kinds expose identical field sets via `getSignalMaps`; provenance format `derived:projections@<ts>` / `curated:PFF@<date>` asserted; adding a hypothetical kind row needs no read-path change (assert reader is kind-agnostic)

## Phase 6: Polish & Cross-Cutting

- [ ] T017 [P] Full sweep: `npm test`, both tsc configs, eslint, build — all clean; 002 perf budget re-checked with signals attached (SC-006)
- [ ] T018 Deploy (migrate remote + deploy), verify production signals populate on the next refresh cycle, spot-check plausibility (SC-002) on the live board, record results in `specs/004-context-signals/quickstart-results.md`

## Dependencies & Execution Order

- Setup → Foundational → US1 → US2 → US3 → Polish
- US2 depends on US1's T011; US3 only on Foundational T005 + data existing (after US1)
- Same-file coordination: T003 touches `espnSource.ts` (also touched by nothing else here); T009/T011 share `compute.ts` (sequential); T012 extends `board.ts`

### Parallel Opportunities

- T001 ∥ T002; T004 ∥ T005 after T003
- US1 tests T006/T007/T008 together; T010 (curated + seed) ∥ T009
- T014 ∥ T016 once US1 lands

## Implementation Strategy

**MVP first**: Phases 1–3 (T001–T013): computed signals visible on details.
Then freshness wiring (US2), the uniformity contract (US3), and the deploy.
Commits land automatically per step via the git extension.
