# Data Model: Projections Pipeline (002)

Store: Cloudflare D1, migration `migrations/0002_projections.sql`. Global
data — no account/league foreign keys (FR-007). Timestamps UTC ISO-8601 TEXT.

## Entity: pro_teams

NFL teams (bye weeks, abbreviations), refreshed with each projection cycle.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| espn_team_id | INTEGER | PK | ESPN proTeamId (0 = free agent pseudo-team, excluded from byes) |
| abbrev | TEXT | NOT NULL | e.g. "ATL" |
| name | TEXT | NOT NULL | |
| bye_week | INTEGER | NULL | Null until schedule published |

## Entity: players

Current-state universe (upserted each refresh; history lives in projections).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| espn_player_id | INTEGER | PK | Stable ESPN id (FR-001); D/ST uses ESPN's negative-id convention as-is |
| full_name | TEXT | NOT NULL | |
| primary_position | TEXT | NOT NULL | QB/RB/WR/TE/K/DST (+pass-through for others) |
| eligible_positions | TEXT | NOT NULL | JSON array of position strings (multi-eligibility edge case) |
| pro_team_id | INTEGER | NOT NULL REFERENCES pro_teams | 0 = free agent |
| active | INTEGER | NOT NULL | 0/1 (FR-003: inactive excluded from default board) |
| injury_status | TEXT | NULL | Display-only context |
| updated_at | TEXT | NOT NULL | Last refresh that touched the row |

## Entity: projection_sets

One row per refresh attempt; **the serving set is the newest `complete`**.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | UUID |
| season | INTEGER | NOT NULL | |
| source | TEXT | NOT NULL | 'espn' (single-source boundary) |
| status | TEXT | NOT NULL CHECK IN ('building','complete') | Flip to complete is the atomic publish (FR-017) |
| trigger | TEXT | NOT NULL CHECK IN ('scheduled','on_demand','draft_day') | Observability + rate-limit bookkeeping |
| fetched_at | TEXT | NOT NULL | Drives freshness labels (FR-006) and cadence policy |
| player_count | INTEGER | NULL | Set on completion; sanity gate (reject suspiciously small fetches) |

Retention (FR-018): all `complete` sets of the current season are kept;
prior-season sets and stale `building` corpses are pruned by the scheduled
job. Index: `(season, status, fetched_at)`.

## Entity: player_projections

Immutable projection rows within a set.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| set_id | TEXT | NOT NULL REFERENCES projection_sets ON DELETE CASCADE | |
| espn_player_id | INTEGER | NOT NULL | Not FK-enforced to players (a set may include a player later removed) |
| stats_json | TEXT | NOT NULL | Lossless map statId → projected amount (FR-004) |
| adp | REAL | NULL | ownership.averageDraftPosition (FR-005); null → dash in UI |
| overall_rank | INTEGER | NULL | Source rank where available |
| PRIMARY KEY | | (set_id, espn_player_id) | |

## Derived: League Board Entry (computed, never stored)

For league L and its scoring map S (001 `league_snapshots.scoring_json`) over
the serving set:

```
points(player) = Σ over categories c in S: projected(c) × S.points(c)   (FR-008)
covered(c)     = projected stat exists for c; uncovered ⇒ 0 points, flagged (FR-009)
pos_rank       = 1-based rank of points within primary_position            (FR-011)
```

Unprojected players (no row in serving set) sort after all projected players
(FR-013). Computed at read time — league scoring changes surface instantly
(FR-010).

## State transitions

```
projection_sets: building ──complete──▶ serving-eligible
                 building ──(refresh failed)──▶ orphan (swept; never served)
players:         upsert-only current state; active flag flips on refresh
```

## Relationships

```
projection_sets 1 ──── * player_projections
players * ──── 1 pro_teams
(league_snapshots ✕ serving set) ──derive──▶ League Board Entry
```
