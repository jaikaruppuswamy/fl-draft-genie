# Phase 1 Data Model: Recommendation Engine

**Feature**: 006 | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

Two kinds of thing live here: **one persisted table** (the preferred list) and a
set of **in-memory shapes** that are the engine's argument and return types.
The engine persists nothing — that is what FR-010 and FR-014 buy.

---

## Persisted

### `preferred_players` (new, migration `0009_preferred.sql`)

| Column | Type | Notes |
|---|---|---|
| `connection_id` | TEXT NOT NULL | FK → `league_connections(id)` **ON DELETE CASCADE** |
| `account_id` | TEXT NOT NULL | FK → `accounts(id)` ON DELETE CASCADE. Carried so isolation is enforceable in the query (FR-020) |
| `season` | INTEGER NOT NULL | a list belongs to a season, not to a league forever |
| `espn_player_id` | INTEGER NOT NULL | **never filtered on sign** — D/ST ids are legitimately negative, around −16000 |
| `created_at` | TEXT NOT NULL | ISO 8601; the deterministic tiebreak for FR-017 |

`PRIMARY KEY (connection_id, season, espn_player_id)` — adding the same player
twice is idempotent, not an error.

`CREATE INDEX idx_preferred_account ON preferred_players (account_id, season);`

**Why it cascades from `league_connections`, when `draft_archives` deliberately
does not**: an archive is season history and must outlive a disconnect. A
preferred list is live intent about a league the owner is currently in — once
they leave, it means nothing. Opposite lifetimes, opposite cascade.

**No FK to `players`.** A preferred player may be released or retired and drop
off the board entirely (FR-021); the row survives and the page explains why the
player cannot be used. A foreign key would make the board's refresh delete the
owner's intent behind their back.

---

## Engine inputs (in memory, no persistence)

### `EngineBundle` — the slow-changing half

Loaded once per request from D1. Everything here changes on the projection
refresh cadence, not per pick.

| Field | Shape | Source |
|---|---|---|
| `players` | `BoardEntry[]` | `buildLeagueBoard()` — already league-scored (002/003) |
| `signals` | `Map<kind, Map<proTeamId, SignalValue>>` | `getSignalMaps()` (004) |
| `roster` | `RosterSnapshot` | `league_snapshots.roster_json` (001) |
| `teamCount` | `number` | `league_snapshots` |
| `preferred` | `Set<espnPlayerId>` | `preferred_players` |
| `adpFloor` | `number \| null` | detected per projection set (research §3) |
| `freshness` | `{ fetchedAt, stale }` | `projection_sets` + `isStale()` |
| `signalFreshness` | `Map<kind, { computedAt, provenance }>` | `signal_entries` |

### `EngineState` — the fast-changing half

Derived from the `DraftSession` snapshot. One per pick.

| Field | Shape | Source |
|---|---|---|
| `revision` | `number` | `SessionSnapshot.revision` — stamped on the output (FR-016) |
| `currentOverall` | `number` | `frontier(state)` |
| `drafted` | `Set<espnPlayerId>` | union of `confirmed` + `pending`, by identity |
| `myRoster` | `{ playerId, position, byeWeek }[]` | the owner's picks so far, plus keepers |
| `gapToNextTurn` | `number \| null` | `picksUntilTurn()` — **null means no next turn** (FR-023) |
| `myRemainingPicks` | `number` | `remainingSchedule().length` |
| `withholding` | `WithholdReason \| null` | 005's liveness verdict (FR-012) |
| `orderTrust` | `"observed" \| "projected" \| "unknown"` | `orderTrust()` |

**`drafted` is the union of confirmed and pending**, deliberately. A pending
pick is a real observed pick whose *overall number* is not yet ledger-confirmed
— the player is unambiguously gone. Treating pending as available would
recommend a player who was just taken, which is the single most visible way this
feature can be wrong.

---

## Engine output

### `RankedBoard`

| Field | Shape | Notes |
|---|---|---|
| `revision` | `number` | FR-016 — a consumer holding an older revision must discard |
| `withheld` | `{ reason, detail } \| null` | when set, `entries` is empty (FR-012) |
| `warnings` | `Warning[]` | stale board, missing signals, unfilled mandatory slots, unsatisfiable roster |
| `shortlist` | `Recommendation[]` | the head — full explanations. Size `SHORTLIST_SIZE = 5`, fixed in code |
| `entries` | `RankedEntry[]` | **every** available player, ordered, value + rank only |
| `forced` | `boolean` | FR-025 — every remaining pick is mandated |

### `RankedEntry`

`{ playerId, name, position, team, rank, rawValue, finalValue, preferred }`

`preferred` is a plain boolean here as well as inside the explanation, so a
display can badge a player below the head without fetching its explanation
(FR-026).

### `Recommendation` = `RankedEntry` + `explanation`

### `Explanation`

| Field | Shape | Notes |
|---|---|---|
| `rawValue` | `number` | points over replacement, league currency |
| `finalValue` | `number` | after adjustments |
| `roundValue` | `number` | the unit everything is expressed in (research §1) |
| `adjustments` | `Adjustment[]` | **empty array means no rule fired** — said plainly, not omitted (US2 AS3) |
| `missing` | `MissingInput[]` | signals or ADP that were unavailable (FR-013) |
| `alternatives` | `{ playerId, name, finalValue }[]` | the next-best few (FR-009) |
| `forcedBy` | `string \| null` | set when FR-025 forced this pick rather than choosing it |

### `Adjustment`

| Field | Shape | Notes |
|---|---|---|
| `rule` | `"offense" \| "sos" \| "oline" \| "bye" \| "scarcity" \| "slot_value" \| "survival" \| "preferred"` | |
| `magnitude` | `number` | **signed**, league currency (FR-027) |
| `direction` | `"up" \| "down"` | redundant with the sign, and deliberately so — a display should not have to infer it |
| `reason` | `string` | the named cause: "top-5 offense", "bye clash with your RB1", "unlikely to last to your next turn" |

**The reconciliation invariant (FR-027, SC-014)**:

```text
finalValue − rawValue === sum(adjustments.map(a => a.magnitude))
```

Asserted for every entry across a full replayed draft, not spot-checked. An
explanation whose parts do not add up to its total is a defect, because it means
something moved the ranking that the owner was never told about.

---

## Relationships

```text
league_connections ──1:N──▶ preferred_players        (cascade: delete together)
accounts           ──1:N──▶ preferred_players        (cascade: delete together)

EngineBundle  ──┐
                ├──▶ recommend()  ──▶ RankedBoard    (pure; no I/O, no clock)
EngineState   ──┘
```

`recommend()` takes no `Date`, no `Env`, no `D1Database`. That is what makes
SC-009 (runs with no network) and SC-010 (reproducible from the archive alone)
assertions about the type signature rather than about the implementation's good
behaviour.

---

## Validation rules

| Rule | Where enforced | Requirement |
|---|---|---|
| A preferred row is reachable only by its owning account | the SQL `WHERE`, not the route | FR-020 |
| A preferred player absent from the board is inert, never fatal | `recommend()` looks up by id and skips misses | FR-021 |
| Negative player ids are valid | no sign filter anywhere | 005's D/ST lesson |
| Adjustments reconcile to the value delta | asserted per entry in replay | FR-027, SC-014 |
| A floored ADP is an absent ADP | `adpFloor` applied before either ADP rule | FR-022, SC-012 |
| Ordering is total | final sort falls through to `espn_player_id` | FR-017 |
| Withheld output carries no entries | `recommend()` returns early | FR-012, SC-007 |
