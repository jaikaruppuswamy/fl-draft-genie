# API Contract: Projections Pipeline (002)

Extends 001's API (same base path, session auth, error envelope
`{error, message}`). All endpoints require the `dg_session` cookie.
League-scoped routes 404 (`unknown_league`) for leagues not owned by the
session account — same isolation rule as 001.

## Board

### GET /api/leagues/:id/board

The full player board for one connected league, in that league's scoring.
One response; filtering/search are client-side (research §5).

- 200:

```jsonc
{
  "freshness": {
    "fetched_at": "2026-08-02T09:00:00Z",   // serving set (FR-006)
    "season": 2026,
    "stale": false                            // true when cadence policy says overdue
  },
  "players": [
    {
      "espn_player_id": 3117251,
      "name": "Christian McCaffrey",
      "position": "RB",                      // primary
      "eligible_positions": ["RB", "FLEX"],
      "team": "SF",                          // abbrev; "FA" when free agent
      "bye_week": 9,                          // null until schedule known
      "projected_points": 268.4,              // league currency, 1-decimal rounded
      "position_rank": 1,                     // within primary position, this league
      "adp": 2.3,                             // null → dash in UI
      "overall_rank": 2                       // source rank; null allowed
    }
    // … sorted by projected_points desc; then unprojected tail:
    , {
      "espn_player_id": 4431611,
      "name": "Deep Rookie",
      "position": "WR",
      "eligible_positions": ["WR"],
      "team": "CHI",
      "bye_week": 7,
      "projected_points": null,              // FR-013: unprojected, listed last
      "position_rank": null,
      "adp": null,
      "overall_rank": null
    }
  ]
}
```

- Ordering: projected players by `projected_points` desc, then unprojected
  players (alphabetical). Inactive players excluded (FR-003).
- 404 `unknown_league`; 409 `no_projections` `{message}` only when no
  complete projection set exists at all (first-ever refresh not yet run).

### GET /api/leagues/:id/board/players/:playerId

Projection detail (US3/FR-014): the stat×value→points derivation.

- 200:

```jsonc
{
  "player": { /* same shape as a board row */ },
  "freshness": { "fetched_at": "…" },
  "breakdown": [
    { "statId": 53, "label": "Receptions", "projected": 88.0, "points_per": 1.0, "points": 88.0, "covered": true },
    { "statId": 42, "label": "Receiving Yards", "projected": 1190.2, "points_per": 0.1, "points": 119.0, "covered": true },
    { "statId": 198, "label": "Stat #198", "projected": null, "points_per": 2.0, "points": 0, "covered": false }
    // one row per league scoring category (covered=false ⇒ FR-009 zero line)
    // plus any projected categories the league does NOT score are omitted
  ],
  "total": 268.4   // = round1(unrounded sum); exactly equals the board's projected_points; Σ of displayed breakdown[].points matches within ±0.05/line (see rounding rule)
}
```

- 404 `unknown_league` / `unknown_player` (not in universe or inactive).
- A player without a projection returns `breakdown: []`, `total: null`.

## Refresh & status

### POST /api/projections/refresh

On-demand global refresh (FR-016). Synchronous: returns when the new set is
complete (or failed).

- 200 `{ "fetched_at": "…", "player_count": 1093, "trigger": "on_demand" }`
- 429 `rate_limited` — more than one global refresh per 15 minutes
- 502 `source_unreachable` — fetch failed; previous serving set untouched
  (FR-017), body includes `serving_fetched_at`

### GET /api/projections/status

- 200 `{ "fetched_at": "…"|null, "season": 2026, "player_count": 1093, "stale": false, "next_scheduled_hint": "daily (draft season)" }`

## Scheduled (not HTTP — extends 001's cron contract)

Every 5-minute tick, after the pre-draft league scan:
1. **Draft-day top-up** (SC-007): if a league entered its pre-draft window
   and the serving set predates the window opening → refresh (`draft_day`).
2. **Cadence**: serving set older than 24 h (Aug 1–Sep 30) or 7 d
   (otherwise) → refresh (`scheduled`).
3. **Pruning**: drop prior-season sets and stale `building` rows.

Failure behavior identical to on-demand: last-good set keeps serving.

## Cross-cutting guarantees

- No endpoint exposes another account's league context (FR-007 data is
  global, but board access is via owned league ids only).
- All point values are computed from the league's own scoring map
  at read time; two leagues may disagree about the same player by design
  (SC-003).
- **Rounding rule** (applies everywhere): internal math is unrounded.
  `projected_points` and detail `total` are the 1-decimal (half-up) rounding
  of the **unrounded sum** — the same computation, so they are exactly equal.
  Each `breakdown[].points` is the 1-decimal rounding of its own unrounded
  product, for display; each line drifts up to ±0.05, so Σ of displayed
  breakdown points matches `total` within ±(0.05 × line count) — assert with
  that tolerance, never exact. SC-002's hand-check tolerance remains ±0.1.
