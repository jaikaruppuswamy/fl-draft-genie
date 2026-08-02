# Tasks: Board Refinements

**Input**: Design documents from `/specs/003-board-refinements/`

## Phase 1: Setup

- [ ] T001 Migration `migrations/0003_tiers.sql`: `tier_entries` (format, position, tier, name_norm, fetched_at, PK(format, position, name_norm)); apply locally

## Phase 2: US2 backend (tiers)

- [ ] T002 [P] [US2] Implement `src/tiers/borischen.ts`: feed keys per (format, position) with base-feed fallback, `Tier N:` line parser, name normalization (case/punct/suffixes/diacritics; DST nickname rule); unit tests in `tests/unit/tiers.test.ts` with inline fixture text (Jr./III/DST cases)
- [ ] T003 [P] [US2] Implement `src/db/tiers.ts`: atomic per-(format,position) replace; `getTierMap(db, format)` → Map("POS:name_norm" → tier)
- [ ] T004 [US2] Implement `ingestTiers(env, now)` (in borischen.ts or ingest site): fetch all formats' feeds, store, log per-feed entry counts and player match rate; wire into `src/sync/predraft.ts` maintenance (after projection ingest / when empty) and `src/api/projections.ts` on-demand refresh — failures logged, never fatal (FR-002)
- [ ] T005 [US2] Board API: league format mapping (≥0.75 PPR / 0.25–0.74 half / else std) + additive `tier` field in `src/api/board.ts`; contract tests in `tests/contract/board-tiers.test.ts` (tier present, format-specific feeds used, unmatched → null, dead source → tierless board)

## Phase 3: UI (US1 + US2 + US3)

- [ ] T006 [US1] `web/src/components/PlayerDetailSheet.tsx`: render covered rows only + "K league categories not covered by projections" note (absent when K=0)
- [ ] T007 [US2] `web/src/pages/LeagueBoard.tsx`: Tier column (dash when null); tier group dividers when a single-position filter is active; `web/src/api.ts` BoardPlayer type gains `tier`
- [ ] T008 [US3] Center board column headers: `.board-table th { text-align: center }` in `web/src/styles.css`, class on the board table

## Phase 4: Polish

- [ ] T009 Full sweep (tests, tsc both, eslint, build)
- [ ] T010 Deploy (migrate remote + deploy), live-verify tiers on production board, record in quickstart-results.md
