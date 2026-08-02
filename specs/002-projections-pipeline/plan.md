# Implementation Plan: Projections Pipeline

**Branch**: `002-projections-pipeline` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-projections-pipeline/spec.md`

## Summary

Build the global player universe + season-projection store and the per-league
player board: ingest ESPN's stat-line-level season projections and ADP into
D1 as immutable, season-retained projection sets (all-or-nothing refresh),
re-score them per league from 001's lossless scoring maps at read time
(projected points + positional rank), and surface a board page plus a
per-player projection-detail breakdown in the existing SPA. Refresh rides the
existing 5-minute cron: daily in Aug–Sep, weekly otherwise, plus the
draft-day top-up when a league enters its pre-draft window; on-demand refresh
is rate-limited.

## Technical Context

**Language/Version**: TypeScript 5.x on Cloudflare Workers (unchanged from 001)

**Primary Dependencies**: Existing stack only — Hono, Zod, React 18/Vite; no new packages

**Storage**: Cloudflare D1 — new tables `pro_teams`, `players`, `projection_sets`, `player_projections` (migration 0002); ~1,100 players × ≤60 sets/season ≈ 66k projection rows (well inside D1 comfort)

**Testing**: Vitest workers pool (as in 001); new sanitized ESPN projection fixtures; hand-computed scoring oracles for SC-002

**Target Platform**: Same Worker + SPA deployment (draft.neelamjai.com)

**Project Type**: Web application — extends the existing single Worker

**Performance Goals**: Board response < 1 s server-side for ~600 players (SC-001 ≤ 2 s end-to-end); full refresh cycle (fetch + parse + write) < 60 s within one cron invocation

**Constraints**: Projection data is global (FR-007) — refresh runs with **no user credentials** (public ESPN endpoints; see research §1); all-or-nothing set swap (FR-017); read-time scoring must reflect league re-syncs instantly (FR-010)

**Scale/Scope**: ~1,100 draftable players; 3 API endpoints + 1 page + 1 detail view; one new cron duty

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Spec-first | PASS | Approved spec + 3 clarifications precede this plan |
| II. Any-league by design | PASS | Boards derive from each league's synced settings; no league hardcoding |
| III. League's currency | PASS | Points computed from 001's lossless stat-map at read time; never a generic format |
| IV. Rules are code | N/A (guarded) | No recommendation rules here; no user knobs added (refresh cadence is fixed code) |
| V. Draft day unforgiving | PASS | Draft-day top-up guarantees same-morning projections (SC-007); failed refresh serves last-good set |
| VI. Recommend, never act | PASS | Projection ingestion is GET-only, unauthenticated public endpoints |
| VII. Explainable | PASS | US3 detail shows the full stat×value→points derivation |
| VIII. Simplicity | PASS | ESPN-only source behind one module; read-time compute (no cache layer); reuses existing cron |
| Security & privacy | PASS | No credentials involved in global refresh; per-account isolation unchanged (board scoped to own leagues) |

**Post-Phase-1 re-check**: PASS — no new services, config surfaces, or
credential paths introduced by the design artifacts.

## Project Structure

### Documentation (this feature)

```text
specs/002-projections-pipeline/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── api.md           # Phase 1 output — board/detail/refresh endpoints
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root — additions to the 001 layout)

```text
migrations/
└── 0002_projections.sql      # pro_teams, players, projection_sets, player_projections
src/
├── projections/
│   ├── espnSource.ts         # Public-endpoint fetchers: players+projections, team byes
│   ├── ingest.ts             # Refresh orchestration: fetch → parse → atomic set write
│   ├── freshness.ts          # Cadence policy (daily/weekly/draft-day top-up), rate limit
│   └── scoring.ts            # stat line × league scoring map → points; positional rank
├── db/
│   ├── players.ts            # players + pro_teams upserts/queries
│   └── projections.ts        # sets + rows; serving-set query; season pruning
├── api/
│   ├── board.ts              # GET board, GET player detail (league-scoped)
│   └── projections.ts        # POST refresh (rate-limited), GET status
└── sync/predraft.ts          # (extend) trigger draft-day top-up from the window scan
src/index.ts                  # (extend) scheduled handler adds freshness check
web/src/pages/
├── LeagueBoard.tsx           # The board: points, pos rank, filters, search, freshness
└── components/PlayerDetailSheet.tsx  # Projection breakdown (US3)
tests/
├── fixtures/espn/kona-players.json   # Sanitized projection sample (~25 players)
├── unit/scoring.test.ts              # Hand-computed oracles (SC-002)
├── contract/board.test.ts, projections-refresh.test.ts
└── integration/projections-flow.test.ts, freshness.test.ts
```

**Structure Decision**: Extend the 001 single-Worker layout — projections are
a sibling module (`src/projections/`) with its own db helpers; no new
deployables. The board lives in the existing SPA behind the existing session
auth.

## Complexity Tracking

No constitution violations to justify — table intentionally empty.
