# Quickstart & Validation: Context Signals (004)

Builds on the running 002/003 app. Contracts: [contracts/api.md](contracts/api.md).

## Setup

```bash
npm run migrate:local
npm run build && npm run dev
```

## Validation scenarios

1. **Compute (US2)** — trigger `POST /api/projections/refresh` (or the
   scheduled tick): signal rows appear for all 32 teams × offense/sos, plus
   oline from the curated file; `computed_at` equals the projection set's
   `fetched_at`.
2. **Plausibility (SC-002)** — query the offense signal ranks: consensus
   elite offenses (by team projected totals) sit top-5; a consensus weak
   offense sits bottom-10.
3. **Detail display (US1, SC-003)** — open an elite player's detail on the
   board: Signals section shows offense/SoS/O-line ranks with labels + bye;
   a free agent shows all dashes.
4. **SoS weighting (FR-002)** — hand-check one team: weighted mean of
   opponent D/ST reference scores (weeks 15–17 doubled) matches the stored
   raw value; rank 1 belongs to the lowest weighted mean.
5. **Curated completeness (SC-005)** — temporarily remove a team from a copy
   of the oline file: loader refuses it loudly and the previous oline signal
   keeps serving.
6. **Failure semantics (FR-008)** — simulate a compute failure (dead
   ESPN base URL → no new projection set → signals untouched); detail still
   serves prior signals.
7. **Perf (SC-006)** — detail response time unchanged within 002's budget.

## Test suite

```bash
npm test   # signal oracles (hand-computed), curated validation, detail contract
```
