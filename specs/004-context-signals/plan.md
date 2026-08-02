# Implementation Plan: Context Signals

**Branch**: `004-context-signals` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-context-signals/spec.md`

## Summary

Compute three team-level signals — offensive potential (derived from serving
projections), strength of schedule (NFL schedule × D/ST-projection-derived
defensive strength, playoff weeks 15–17 double-weighted), and O-line rank
(curated PFF-seeded repo file) — store them in one uniform shape with
per-kind atomic replace, recompute after every projection refresh, and
surface them as a Signals section in the player detail sheet. Bye weeks are
reused from 002.

## Technical Context

**Stack**: unchanged (Workers/Hono/D1/React; no new dependencies)

**Storage**: one new table `signal_entries` (kind, team, raw, score, rank,
provenance, computed_at; PK kind+team) — migration 0004; per-kind replace is
a single transactional D1 batch (the tier_entries pattern)

**New data inputs**: the NFL schedule, parsed from the *already-fetched*
`proTeamSchedules_wl` view (`proGamesByScoringPeriod`); the curated O-line
JSON file in-repo. No new network sources.

**Reference scoring**: signals are global, so team offense/defense strength
is computed by scoring stat lines with a fixed in-code reference map (not
any league's scoring) — see research §2

**Performance**: signal computation is 32 teams × arithmetic — negligible;
detail response adds one indexed read (002 SC-001 budget holds)

**Testing**: Vitest workers pool; fixtures extended with schedule data;
deterministic hand-computed signal oracles

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I Spec-first | PASS | Spec + 3 owner clarifications precede |
| II Any-league | PASS | Signals are global/league-agnostic; nothing hardcoded per league |
| III League currency | PASS | Untouched — signals supplement, never replace league-scored points (reference scoring is for cross-team comparison only, documented) |
| IV Rules are code | PASS | Weights (playoff ×2), reference scoring, label thresholds — all constants in code; curated file is repo-versioned, not user-editable |
| V Draft day | PASS | Signals ride the refresh; failure keeps last-good; detail never blocks |
| VI Read-only | PASS | No new external calls at all |
| VII Explainable | PASS | Ranks + plain-language labels; provenance stored |
| VIII Simplicity | PASS | Derive-don't-fetch ratified; one table, one compute module, one seed file |

**Post-Phase-1 re-check**: PASS — no new services or config surfaces.

## Project Structure

### Documentation (this feature)

```text
specs/004-context-signals/
├── plan.md, research.md, data-model.md, quickstart.md
├── contracts/api.md
└── tasks.md (next phase)
```

### Source Code (additions)

```text
migrations/0004_signals.sql
src/signals/
├── reference.ts        # fixed reference scoring maps (offense, D/ST)
├── compute.ts          # offense + SoS computation, normalize/rank/label
├── curated.ts          # O-line file loader + 32-team completeness check
└── data/oline-2026.json
src/db/signals.ts       # per-kind atomic replace; read map for detail
src/projections/espnSource.ts  # (extend) parse proGamesByScoringPeriod → schedule
src/sync/predraft.ts    # (extend) computeSignals after projection refresh
src/api/board.ts        # (extend) detail response gains signals block
web/src/components/PlayerDetailSheet.tsx  # Signals section
tests/unit/signals.test.ts, tests/contract/detail-signals.test.ts
tests/fixtures/espn/proteams.json  # (extend) add proGamesByScoringPeriod
```

**Structure Decision**: same single-Worker layout; signals are a sibling
module mirroring `projections/` and `tiers/`.

## Complexity Tracking

No violations — table intentionally empty.
