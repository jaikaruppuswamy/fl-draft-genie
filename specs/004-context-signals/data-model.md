# Data Model: Context Signals (004)

Store: Cloudflare D1, migration `migrations/0004_signals.sql`. Global data
(no league/account keys). Per-kind writes are atomic (single D1 batch).

## Table: signal_entries

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| kind | TEXT | NOT NULL, CHECK IN ('offense','sos','oline') | New kinds = new CHECK value + data, no schema change (FR-006) |
| pro_team_id | INTEGER | NOT NULL | FK-in-spirit to pro_teams (002) |
| raw_value | REAL | NOT NULL | Kind-specific units (reference points; weighted opponent strength; source rank) |
| score | REAL | NOT NULL | Normalized 0–100; 100 = favorable end, always (research §3) |
| rank | INTEGER | NOT NULL | 1–32; 1 = favorable end (best offense / easiest SoS / best O-line) |
| provenance | TEXT | NOT NULL | e.g. 'derived:projections@<fetched_at>' or 'curated:PFF@<seeded_at>' |
| computed_at | TEXT | NOT NULL | Lockstep with the projection serving set for derived kinds (SC-004) |
| PRIMARY KEY | | (kind, pro_team_id) | |

## Curated file: src/signals/data/oline-<season>.json

```jsonc
{
  "kind": "oline",
  "season": 2026,
  "source": "PFF preseason OL rankings",
  "source_url": "…",
  "seeded_at": "2026-08-02",
  "provisional": false,        // true ⇒ owner review pending (surfaced in provenance)
  "entries": [ { "team_abbrev": "PHI", "rank": 1 }, … ]  // exactly 32
}
```

Loader validation (SC-005): exactly 32 entries; every abbrev resolves in
`pro_teams`; ranks are a permutation of 1–32. Any failure → previous stored
signal keeps serving; loud log.

## Derived (not stored): detail signals block

For a player on team T, the detail response attaches:

```
signals: {
  offense: { rank, score, label } | null,
  sos:     { rank, score, label } | null,
  oline:   { rank, score, label } | null,
  bye_week: number | null            // from pro_teams (002), FR-004
}
```

null per-kind when the team has no entry (edge cases: FA, missing curated
row, schedule unknown → sos null).

## Relationships

```
pro_teams 1 ──── * signal_entries (by kind)
players * ──── 1 pro_teams  →  detail joins player → team → signals
```
