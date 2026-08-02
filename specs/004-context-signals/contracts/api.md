# API Contract: Context Signals (004)

No new endpoints. One **additive** change to the 002 detail contract, plus
the scheduled-job contract extension.

## GET /api/leagues/:id/board/players/:playerId  (extended)

The response gains a `signals` object (see data-model.md for the shape):

```jsonc
{
  "player": { … },            // unchanged (002 + 003 tier)
  "freshness": { … },         // unchanged
  "breakdown": [ … ],         // unchanged
  "total": 268.4,              // unchanged
  "signals": {
    "offense": { "rank": 3, "score": 91.2, "label": "Top-5 offense" },
    "sos":     { "rank": 21, "score": 34.0, "label": "Mid-pack schedule" },
    "oline":   { "rank": 7, "score": 80.5, "label": "Top-10 O-line" },
    "bye_week": 9
  }
}
```

- Any kind may be `null` (free agent, missing curated entry, unknown
  schedule) — clients render dashes (FR-009/FR-010).
- Ranks: 1 = favorable end for every kind (1 = easiest schedule). Scores:
  0–100, 100 = favorable. Labels come from the fixed thresholds in code.
- Board list response is unchanged (signals are detail-only in this feature).

## Scheduled contract (extends 001/002 cron duties)

After a successful projection refresh (any trigger) — and whenever the
signals table is empty — recompute `offense` and `sos` from the new serving
set and (re)load the curated `oline` file. Per-kind atomic; failures logged,
never fatal, previous values keep serving (FR-007/FR-008).

## Cross-cutting

- Signals are global: identical for every league and account; served only
  through league-scoped endpoints the session already owns.
- `computed_at` of derived kinds equals the serving projection set's
  `fetched_at` (SC-004 assertion hook).
