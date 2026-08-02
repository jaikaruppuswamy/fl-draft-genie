# Tasks: Projections Pipeline

**Input**: Design documents from `/specs/002-projections-pipeline/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md — and a working 001 build (this feature extends it)

**Tests**: Included — SC-002's hand-computed scoring oracles and the
established 001 testing pattern (fixtures, contract, integration) apply.
Tests first per story; watch them fail.

**Organization**: Grouped by user story: US1 (player board), US2 (freshness),
US3 (projection detail).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)

## Phase 1: Setup

**Purpose**: Schema and fixtures every story needs.

- [ ] T001 Write D1 migration `migrations/0002_projections.sql`: tables `pro_teams`, `players`, `projection_sets`, `player_projections` with constraints and indexes per data-model.md; verify `npm run migrate:local` applies cleanly on top of 0001
- [ ] T002 [P] Author sanitized ESPN fixtures `tests/fixtures/espn/kona-players.json` (~25 players spanning QB/RB/WR/TE/K/DST, one multi-position player, one unprojected rookie, one player projected in a stat no league scores, realistic `stats[]` with statSourceId=1/statSplitTypeId=0, ADP + draft ranks) and `tests/fixtures/espn/proteams.json` (proTeamSchedules_wl shape with byeWeek); document re-recording (public endpoints, no cookies) in `tests/fixtures/espn/README.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Ingestion path — without stored projections no story is testable.

**⚠️ CRITICAL**: No user story work until this phase completes.

- [ ] T003 Implement public-endpoint source in `src/projections/espnSource.ts`: `fetchPlayers(season)` (kona_player_info against leaguedefaults/3 with X-Fantasy-Filter header, limit 1500, projection-source filter) and `fetchProTeams(season)` (proTeamSchedules_wl); no Cookie header ever; typed parse to `{player, statLine, adp, overallRank}` records; error mapping reusing EspnError codes; unit test against fixtures in `tests/unit/espnSource.test.ts`
- [ ] T004 [P] Implement `src/db/players.ts`: batch upsert pro_teams and players (active flag, eligible positions JSON), queries for board universe (active players joined to team abbrev + bye)
- [ ] T005 [P] Implement `src/db/projections.ts`: create `building` set, chunked batch-insert projection rows, atomic `complete` flip with player_count, serving-set query (newest complete for season), set-by-id rows fetch, prune (prior seasons + stale building > 1 h)
- [ ] T006 Implement refresh orchestration in `src/projections/ingest.ts`: fetch teams + players → upserts → new building set → rows → sanity gate (reject < 300 players, FR-017 spirit) → complete flip; on any failure leave prior serving set untouched and return a typed error; integration test `tests/integration/projections-flow.test.ts` (ingest from fixtures → serving set exists; simulated fetch failure → previous set still serving) (depends on T003–T005)

**Checkpoint**: `ingest()` from fixtures yields a queryable serving set.

---

## Phase 3: User Story 1 - Browse my league's player board (Priority: P1) 🎯 MVP

**Goal**: Per-league board: points in league currency, positional rank, position/team/bye/ADP, filter + search, unprojected tail.

**Independent Test**: Quickstart scenarios 2/3/5 — board sorted by points, ranks per position, cross-league totals differ, hand-computed spot checks match.

### Tests for User Story 1

- [ ] T007 [P] [US1] Scoring oracle unit tests in `tests/unit/scoring.test.ts`: hand-computed expected points for fixture players under PPR, 0.5-PPR, and standard scoring maps (SC-002 ±0.1 at API rounding); positional-rank ordering incl. tie behavior; uncovered-category → 0; unprojected → null
- [ ] T008 [P] [US1] Contract tests in `tests/contract/board.test.ts`: GET /api/leagues/:id/board response shape per contracts/api.md — ordering (points desc, unprojected alphabetical tail), inactive players excluded, `freshness` block present, 404 unknown_league, cross-account 404, 409 no_projections before first ingest; SC-003 assertion: same fixture player differs between PPR and standard league boards

### Implementation for User Story 1

- [ ] T009 [US1] Implement `src/projections/scoring.ts`: `scoreStatLine(statsJson, scoringMap)` → unrounded points + per-category breakdown with covered flags (FR-008/009); `buildLeagueBoard(projections, players, scoringMap)` → sorted entries with 1-decimal API rounding and positional ranks (FR-011/013) (depends on T007 existing and failing)
- [ ] T010 [US1] Implement `GET /api/leagues/:id/board` in `src/api/board.ts` (league-scoped via 001's `getConnectionById`, serving-set load, scoring.ts compute, contract response incl. freshness/stale flag) and mount in `src/api/app.ts`
- [ ] T011 [US1] Build `web/src/pages/LeagueBoard.tsx`: full-board fetch, client-side position filter chips (from league's positions) + name search composing, points/pos-rank/team/bye/ADP columns (Organic table styles), unprojected section at bottom, freshness label; route `/leagues/:id/board` in `web/src/App.tsx`; "Player board" button on `web/src/pages/LeagueDetail.tsx` and dashboard league cards
- [ ] T012 [US1] Extend `web/src/api.ts` with typed `getBoard(leagueId)` (+ types for board rows) used by T011

**Checkpoint**: MVP — a connected league's true cheat sheet, in its own scoring.

---

## Phase 4: User Story 2 - Projections stay fresh (Priority: P2)

**Goal**: Scheduled daily/weekly refresh, draft-day top-up, rate-limited on-demand refresh, honest freshness labels.

**Independent Test**: Quickstart scenarios 1/6/7/8 — manual refresh advances `fetched_at`, second within 15 min → 429, aged serving set triggers scheduled refresh, pre-draft window forces top-up, dead source leaves old set serving.

### Tests for User Story 2

- [ ] T013 [P] [US2] Contract tests in `tests/contract/projections-refresh.test.ts`: POST /api/projections/refresh 200 shape + `trigger: on_demand`, second call within 15 min → 429 rate_limited, source down → 502 source_unreachable with `serving_fetched_at`, GET /api/projections/status shape incl. stale flag
- [ ] T014 [P] [US2] Freshness policy integration tests in `tests/integration/freshness.test.ts` (fake clocks): Aug serving set aged 25 h → scheduled refresh fires; Oct aged 3 d → no refresh; Oct aged 8 d → fires; league entering pre-draft window with pre-window serving set → `draft_day` trigger (SC-007); prior-season sets pruned

### Implementation for User Story 2

- [ ] T015 [US2] Implement cadence policy in `src/projections/freshness.ts`: `isStale(fetchedAt, now)` (24 h in Aug 1–Sep 30, else 7 d), `dueForDraftDayTopUp(windows, servingFetchedAt)`, on-demand rate-limit check (≥ 15 min since newest set of any trigger) — constants in code, no config (constitution IV spirit)
- [ ] T016 [US2] Implement `src/api/projections.ts` (`POST /api/projections/refresh` → rate-limit → ingest → 200/429/502 per contract; `GET /api/projections/status`) and mount in `src/api/app.ts` (depends on T015)
- [ ] T017 [US2] Wire the scheduled path: extend `src/index.ts` scheduled handler and `src/sync/predraft.ts` so each 5-min tick, after the league scan, runs draft-day top-up check → cadence check → pruning, using `freshness.ts` + `ingest.ts` (depends on T015)
- [ ] T018 [US2] Surface freshness in the SPA: "Refresh projections" button (429-friendly message) + `fetched_at` age label + stale badge on `web/src/pages/LeagueBoard.tsx` via `web/src/api.ts` refresh/status methods

**Checkpoint**: Numbers stay current without anyone thinking about it; draft morning is guaranteed fresh.

---

## Phase 5: User Story 3 - See why a projection is what it is (Priority: P3)

**Goal**: Tap a player → stat-by-stat derivation summing to the total (constitution VII).

**Independent Test**: Quickstart scenario 4 — breakdown lines multiply and sum correctly; uncovered categories show zero with a note; PPR vs non-PPR detail differs on the receptions line.

### Tests for User Story 3

- [ ] T019 [P] [US3] Contract tests in `tests/contract/board-detail.test.ts`: GET /api/leagues/:id/board/players/:playerId — breakdown rows carry statId/label/projected/points_per/points/covered, Σ points equals `total` equals the board's `projected_points`, uncovered league category present with covered=false and points 0, unprojected player → empty breakdown + null total, 404 unknown_player for inactive/unknown ids

### Implementation for User Story 3

- [ ] T020 [US3] Implement the detail endpoint in `src/api/board.ts` reusing `scoring.ts`'s per-category breakdown (no duplicate math) per contracts/api.md (depends on T019 failing first)
- [ ] T021 [US3] Build `web/src/components/PlayerDetailSheet.tsx` (Organic dialog/sheet: player header, breakdown table, uncovered-category note, total row) and wire row-tap in `web/src/pages/LeagueBoard.tsx` + `getPlayerDetail` in `web/src/api.ts`

**Checkpoint**: Every number on the board can explain itself.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T022 [P] Board performance check against SC-001: seed the local DB with a full-size ingest (fixture multiplied or live fetch), measure GET board server time < 1 s and page load < 2 s; record numbers in `specs/002-projections-pipeline/quickstart-results.md` (created in T024)
- [ ] T023 [P] Full-suite sweep: `npm test`, `npx tsc --noEmit`, `npx tsc -p web/tsconfig.json --noEmit`, `npx eslint .` all clean; confirm 001 suites unaffected
- [ ] T024 Run quickstart.md live validation (first real ESPN ingest, hand-check scoring across the owner's 3 leagues — scenarios 1–3 need the owner's leagues), record results in `specs/002-projections-pipeline/quickstart-results.md`
- [ ] T025 Deploy: `npm run migrate:remote`, `npm run deploy`, smoke-test board + refresh on https://draft.neelamjai.com; update `README.md` status

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)** → **Foundational (P2)** → user stories
- **US1 (P3)**: after Foundational — needs a serving set to render
- **US2 (P4)**: after Foundational; independent of US1 except the T018 UI lands on US1's board page
- **US3 (P5)**: after US1 (reuses scoring breakdown + board page)
- **Polish (P6)**: after all stories

### Within Each User Story

- Tests first (fail) → services → endpoints → SPA
- Same-file sequences: T010 → T016 mounts in `src/api/app.ts` (coordinate); T011 → T018 → T021 all touch `LeagueBoard.tsx`; T012 → T018 → T021 extend `web/src/api.ts`

### Parallel Opportunities

- T001 ∥ T002; T004 ∥ T005 after T003
- US1: T007 ∥ T008 together, then T009 while T011/T012 scaffold in parallel
- US2 tests T013 ∥ T014; US2 (T015–T017) can proceed in parallel with US3 backend (T019–T020) once US1 is done

## Parallel Example: User Story 1

```bash
# Tests first, together:
Task: "Scoring oracle unit tests in tests/unit/scoring.test.ts"
Task: "Board contract tests in tests/contract/board.test.ts"

# Then engine + UI scaffolding in parallel:
Task: "Implement src/projections/scoring.ts"
Task: "Build web/src/pages/LeagueBoard.tsx skeleton + route"
```

## Implementation Strategy

**MVP first**: Phases 1–3 (T001–T012), then STOP and validate the board
against a real league (quickstart 2–3). That alone is the draft-prep cheat
sheet in your league's currency.

**Incremental delivery**: add US2 (freshness + draft-day guarantee — the
draft-day-critical piece), then US3 (explainability), then polish ending in
the production deploy (T025). Commits land automatically per step via the
git extension.
