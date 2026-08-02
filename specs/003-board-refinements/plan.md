# Implementation Plan: Board Refinements

**Branch**: `003-board-refinements` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

## Summary

Three refinements to the 002 board: (1) the projection detail lists only
covered categories with an omitted-count note (display-layer only — 002 API
contract untouched); (2) player tiers ingested from Boris Chen's public text
feeds per scoring format, stored globally, joined onto the board by
normalized name + position, grouped visually under single-position filters;
(3) the board table's column headers center-aligned.

## Technical Context

Stack unchanged (Workers/Hono/D1/React). New: one D1 table (`tier_entries`,
migration 0003), one source module, one db helper, board response gains an
additive `tier` field. **Live-verified feed format** (probed 2026-08-02):
`https://s3-us-west-1.amazonaws.com/fftiers/out/text_{KEY}.txt`, lines
`Tier N: Name, Name, …`; keys: `QB`/`K`/`DST` (format-independent),
`RB`/`WR`/`TE` with `-PPR`/`-HALF` variants (format-specific feed 4xx → fall
back to the base feed). DST feed uses full team names → match on nickname.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I Spec-first | PASS | Spec + owner clarifications precede |
| II Any-league | PASS | Format mapping derives from each league's reception scoring |
| III League currency | PASS | Points untouched; tiers are per-format supplemental data |
| IV Rules are code | PASS | No knobs; format thresholds in code |
| V Draft-day | PASS | Tier fetch failure never blocks the board; last-good serves |
| VI Read-only | PASS | GET-only public text feeds, no credentials |
| VII Explainable | PASS | Count note preserves uncovered-category visibility |
| VIII Simplicity | PASS | One table, one module; no new deps |

**Post-design re-check**: PASS.

## Structure (additions)

```text
migrations/0003_tiers.sql
src/tiers/borischen.ts        # fetch + parse + name normalization
src/db/tiers.ts               # per-(format,position) replace; lookup map
src/api/board.ts              # (extend) tier field via format mapping
src/sync/predraft.ts          # (extend) tier refresh alongside projection ingest
src/api/projections.ts        # (extend) on-demand refresh also refreshes tiers
web/src/components/PlayerDetailSheet.tsx  # covered-only + count note
web/src/pages/LeagueBoard.tsx # tier column, tier groupings, .board-table
web/src/styles.css            # .board-table th centered
tests/unit/tiers.test.ts, tests/contract/board-tiers.test.ts
```

Board `tier` field is additive to the 002 contract (nullable integer);
noted here rather than rewriting the 002 contract document.
