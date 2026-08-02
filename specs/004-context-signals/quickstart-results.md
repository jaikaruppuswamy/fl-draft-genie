# Validation Results — 004 Context Signals

**Date**: 2026-08-02 · local wrangler dev with live sources, then production.

- **Tests**: 131/131 green (20 new): hand-computed offense/SoS oracles
  (playoff ×2 weighting, mean-fill for unknown opponents, tie-break by team
  id), curated-file validation incl. the invalid-reload-keeps-previous case,
  detail-signals contract, lockstep freshness, uniform-shape contract.
- **Live spot-check (SC-002 plausibility)**: Jahmyr Gibbs (DET) → offense
  rank 2 "Top-5 offense", SoS rank 3 "Top-5 schedule", O-line rank 12
  (provisional seed), bye 6 — all plausible against 2026 consensus.
- **UI**: Signals grid renders in the detail sheet above the streamlined
  breakdown (verified in browser).
- **O-line seed**: PFF's full 2026 preseason list is paywalled beyond its
  top-3 (Broncos/Colts/Bears confirmed from PFF's final-2025 article).
  `src/signals/data/oline-2026.json` ships **provisional: true** — anchored
  on the confirmed PFF points + 2026 preseason notes, provenance states
  this honestly. **Owner action**: review/replace with PFF's full 2026
  preseason order when accessible, set provisional: false.
- **Production**: migration 0004 applied; deployed; signals computed by the
  cron (empty-table trigger) — verified via remote D1 (see below).
