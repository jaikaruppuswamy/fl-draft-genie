# Quickstart & Validation: Projections Pipeline (002)

Contracts: [contracts/api.md](contracts/api.md) · Schema:
[data-model.md](data-model.md) · Builds on the running 001 app.

## Prerequisites

- 001 set up and working locally (see its quickstart): signed in, ≥ 1 real
  league connected (3 leagues with different scoring for SC-002/003).
- Apply the new migration: `npm run migrate:local` (and `migrate:remote` at
  deploy).

## Setup

```bash
npm install        # no new deps expected
npm run migrate:local
npm run build && npm run dev
```

## Validation scenarios

1. **First refresh (US2)** — with an empty projections store, trigger a
   refresh: `curl -X POST …/api/projections/refresh` with your session cookie
   (the board-page button arrives with US2/T018; at the US1-only checkpoint
   the board shows its "no projections yet" state instead). Expect `player_count` ≳ 1000 and a fresh
   `fetched_at`. The board renders immediately after.
2. **Board sanity (US1, SC-001)** — open a league's board: ≥ 300 projected
   players, sorted by points, top names plausible (elite RB/WR up top);
   loads in well under 2 s; positional ranks read RB1, RB2, … within each
   position filter.
3. **League-currency check (SC-002/003)** — pick 3–10 players; for each,
   open the projection detail and hand-multiply two or three categories
   (e.g., receptions × per-catch value) against a calculator; totals match
   within 0.1. Compare the same player across your PPR and non-PPR leagues:
   different totals, PPR higher for pass-catchers.
4. **Detail explainability (US3)** — verify the breakdown lines sum to the
   total, and a league-scored category ESPN doesn't project shows a zero
   "not covered" line.
5. **Filters & search (US1)** — RB filter shows only RB-eligible players
   (multi-eligible players appear in each of their positions); search
   composes with the filter; unprojected players sit at the bottom marked
   "no projection".
6. **Freshness & cadence (US2, SC-004)** — check the board's freshness
   label; then re-trigger refresh within 15 minutes and expect a 429
   rate-limit with friendly text. For the scheduled path locally:

   ```bash
   curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
   ```

   with the serving set aged > 24 h (simulate via `NOW_OVERRIDE` or by
   editing `fetched_at` in the local DB) → a new set appears.
7. **Draft-day top-up (SC-007)** — with a league whose draft is ~70 min out
   (fixture or real), run the scheduled tick and confirm a `draft_day`
   trigger set is created if the serving set predates the window.
8. **Failure semantics (FR-017)** — point `ESPN_BASE_URL` at a dead port,
   trigger a refresh: expect `source_unreachable`, and the board still
   serves the previous set with its age label.
9. **League re-sync reflects instantly (FR-010)** — change a scoring value
   in a test league on ESPN, "sync now" (001 flow), reload the board: points
   shift without any projection refresh.

## Test suite

```bash
npm test    # scoring oracles (SC-002), board/refresh contracts, ingest flow, freshness policy
```

CI never calls live ESPN (fixtures only); scenarios 1–3 above are the manual
live checks against the real source before calling 002 done.
