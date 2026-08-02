# Quickstart Validation Results — 002 Projections Pipeline

**Date**: 2026-08-02 · **Environment**: local wrangler dev against **live ESPN
public endpoints** (no credentials involved), then production deploy.

## Automated coverage

101 tests green (33 new for 002): scoring oracles (SC-002), board/refresh/
detail contracts, ingest all-or-nothing semantics, cadence + draft-day top-up
policy (SC-004/SC-007), FR-010 instant re-score.

## Live validation (scenarios 1, 2, 6 — real ESPN data)

| Check | Result |
|-------|--------|
| First real ingest (`POST /api/projections/refresh`) | ✅ **522 projected players** (1,026 in universe) in **2.8 s** end-to-end — sanity gate passed |
| Board perf (SC-001) | ✅ **37 ms** server time for the full board (207 KB JSON, 1,026 players) — budget was 1 s |
| Board sanity | ✅ Top of 2026 PPR board: Gibbs RB1 364.7, Allen QB1 363.6, Nacua WR1 356.2, Bijan RB2 351.6, CMC RB3 342 — with live ADPs (Gibbs 1.76) and byes |
| Detail derivation (US3) | ✅ Gibbs: 1374.1 rush yds × 0.1 + 14.5 TD × 6 + … = 364.7; uncovered categories shown as zero "not projected" lines |
| Rate limit | ✅ Second refresh within 15 min → 429 (contract tests) |
| Rounding drift | ⚠️→✅ Real data exposed that Σ of per-line rounded points can drift > ±0.05 from the total (0.05 × line count is the true bound) — contract and tests corrected during validation |
| Dialog styles | ⚠️→✅ The Organic port had omitted `.dialog-*` styles; the detail sheet rendered unstyled. Fixed and rebuilt during validation |

Validation league: a seeded connection using the PPR fixture scoring map
("Stat #N" labels are a seeding artifact — real leagues carry 001's labels).

## Production

Migration 0002 applied to remote D1 (first attempt hit a transient API error;
retry applied cleanly). Deployed to https://draft.neelamjai.com; the 5-minute
cron self-populates projections (serving set absent → stale → scheduled
ingest) — **verified**: within 5 minutes of deploy, a complete `scheduled`
set appeared remotely with 522 projected players / 1,026-player universe,
matching local. SPA serving 200 on the custom domain.

## Remaining (owner)

Scenario 3 (SC-002/003 hand-check across the owner's three real leagues) —
open each league's Player board on draft.neelamjai.com, spot-check 3–10
players' detail math per league, and confirm PPR vs standard totals differ.
