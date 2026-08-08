# Data Model: Deployment Ops

**Feature**: 009-deployment-ops | **Phase 1** | **Date**: 2026-08-08

**One new table.** Everything else this feature needs is already written by
shipped code — the work is reading it correctly, which research showed is where
the obvious answers go wrong.

---

## New: `ops_conditions` (migration `0014`)

One row per *condition*, not per tick. The table exists for one reason: **`stage()`
catches every throw and returns void, so nothing survives between cron
invocations.** FR-002 ("repeatedly rather than once") and FR-006 (bounded
repetition) are both counters, and a counter needs a home.

| Column | Type | Purpose |
|---|---|---|
| `key` | TEXT PRIMARY KEY | condition + scope, e.g. `stage:archive`, `draft_lapsed:<espn_league_id>:<season>` |
| `kind` | TEXT NOT NULL | the condition class, from a closed vocabulary — what the alert renders from |
| `scope` | TEXT | `espn_league_id:season` where a league is implicated, else NULL |
| `last_ok_at` | TEXT | last observation where the condition was **false** (healthy) |
| `last_failed_at` | TEXT | last observation where it was **true** |
| `consecutive` | INTEGER NOT NULL DEFAULT 0 | consecutive true observations — FR-002 |
| `last_error_code` | TEXT | a **bounded code**, never a free-text message — see below |
| `last_notified_at` | TEXT | FR-006 |
| `notify_count` | INTEGER NOT NULL DEFAULT 0 | FR-006 — bounded repetition |
| `resolved_at` | TEXT | set when the condition goes false, so a recurrence can notify again |
| `updated_at` | TEXT NOT NULL | |

Indexed on `(kind)` for the scan; the table is small enough that nothing else is
warranted.

### Rules that are not negotiable

**`last_error_code` is a bounded code.** Never an exception message, never an
ESPN payload fragment. `redact()` strips braced SWIDs, `espn_s2` assignments and
long blobs — **not bare UUIDs** — and `scripts/privacy-sweep.ts` walks files, so
it can never inspect a D1 row. A free-text column here would be an unwatched
privacy surface that grows on a schedule.

**`scope` holds `espn_league_id` and `season`, never `connection_id`.** A
connection id is a UUID mapping 1:1 to an account and a league, and under 011's
fan-out `listConnectionsForLeague()` deliberately returns other accounts' rows.
Storing one, then rendering it, names a person indirectly.

**No account column, deliberately.** This table is operator-scoped state about
the *service*, not user data — and it observes across accounts by design. That is
permitted by the **operator exemption ratified into the constitution (1.2.0) on
2026-08-08**, which covers the league identifier and nothing else. Without it
this table would violate the isolation rule; with it, the scope of what may be
stored and rendered is bounded in writing rather than by habit.

### State transitions

```text
                observation false          observation true
                ─────────────────          ────────────────
absent      →   row created, consecutive=0, last_ok_at set
healthy     →   consecutive=0              consecutive=1, last_failed_at set
                resolved_at set
suspected   →   consecutive=0              consecutive=2  → NOTIFY
(consecutive=1) resolved_at set                            notify_count++
notified    →   consecutive=0              consecutive++
                resolved_at set            notify again only per FR-006 backoff
                (recurrence may notify)
```

The two-observation gate is the same pattern
`league_snapshots.espn_reset_suspected_at` already uses for observed resets: one
observation raises a suspicion, a second confirms, and any healthy observation
clears it. It costs no extra reads because the cron already runs every five
minutes.

**The live-draft conditions are exempt from the two-observation gate**, or SC-002
cannot be met even with the faster trigger. Both already carry their debounce in
the threshold: the relay lapse at 150 s is three missed 45 s beats, and the
picks-stalled check at **5 minutes** (FR-003a, ratified 2026-08-08) is roughly
three missed pick slots against the 90 s+ human cadence 005 measured. Doubling
either doubles detection time on the one path that matters most.

**These conditions are evaluated on a 1-minute trigger** (FR-003c), separate from
the 5-minute maintenance run and short-circuiting when no draft is armed.
Clarify ratified SC-002 at five minutes, and on the 5-minute grid the worst case
is 7.5 minutes — the criterion would have been knowingly unmet.

---

## Existing state this feature reads

Nothing below changes shape. What changed is *which* column is correct — research
§6 found the obvious choice wrong in three of five cases.

| Signal | Source | Note |
|---|---|---|
| Projection freshness | `projection_sets.fetched_at` via `getServingSet()` + `isStale()` | 24 h in Aug/Sep, 7 d otherwise |
| Signal freshness | `MAX(signal_entries.computed_at)` | **independent** of projections — `computeSignals` is gated on `refreshed \|\| empty`, so a signals failure never co-fires |
| League sync | `league_connections.last_sync_at`, `last_sync_status` | already written by two of the five stages |
| Draft liveness gate | `draft_sessions.completed_at IS NULL AND armed_at IS NOT NULL AND last_heartbeat_at IS NOT NULL` | **not** `isLiveDraft()` — see below |
| Tap alive | `draft_sessions.last_heartbeat_at`, `heartbeat_hidden` + `heartbeatLapsed()` | means "the tap process died", **not** "picks stopped" |
| Picks flowing | `MAX(tap_batches.received_at)` for `(espn_league_id, season)` | the predicate the heartbeat cannot supply |
| Server consuming | `snapshot().revision`, polled by the cron, stored in `ops_conditions` | **not** `saveCursor()` — see below |
| Archive done | `draft_archives` row exists for a league whose draft date has passed | **not** `sessionsAwaitingArchive()` age |
| Database size | `wrangler d1 info` `database_size` | replaces the bound removed by FR-021 |

### Columns that must NOT be read, and why

**`draft_sessions.status`.** `not_receiving` and `degraded` are declared in the
schema comment, in `SessionStatus`, and in this spec's own Dependencies list —
and **nothing ever writes them**. `markSessionStatus` writes only `live` and
`complete`. Both production sessions currently read `idle` while their taps read
`relaying`/`watching`. Any threshold on this column is testing for values that
cannot occur.

**`consecutive_errors`** — written by nothing. **`last_error`** — written by one
path (the armed-deadline abort) and never cleared by `resetSession()`, so a
healthy idle production session still carries `armed_deadline` from 2026-08-07.

**`feed_received_at` / `feed_id`** — dead columns. `saveCursor()` has zero
callers; both are NULL in production after 408 relayed batches. Reviving it would
put a D1 write inside the Durable Object's `blockConcurrencyWhile` gate that
draft-room snapshot reads contend for. The cron polling `snapshot().revision`
gets the same fact for no draft-day cost.

**Row counts, on any table.** `signal_entries` is fixed-size by its primary key;
`draft_archives` grows once per league per season; `projection_sets` is pruned.
**Freshness timestamps are the shape that works.**

---

## Changed behaviour in existing code

| Where | Change | Why |
|---|---|---|
| `src/sync/predraft.ts` | `stage()` returns `{ ok, code?, produced? }` instead of void | FR-001/FR-002 need an outcome; FR-004 needs a produced-count, since "ran without error" and "produced what it should" are different facts |
| `src/index.ts` | `await` the scheduled run rather than bare `ctx.waitUntil` | today a failing tick reports success to the platform, and the ops write can be torn down |
| `src/db/projections.ts` | `pruneSets()` no longer deletes prior seasons | FR-021 — contradicts 002's ratified retention; ~16 MB/season measured |
| `scripts/privacy-sweep.ts` | GUID branch reports a count, not `slice(0,8)`; `espn_s2` regex covers JSON and raw-cookie shapes | FR-011 — the gate currently prints 32 bits of a real SWID |

The `pruneSets()` change keeps the stale-`building` sweep. 002's clarification log
is **not** edited — a dated superseding note is added to its FR-018 instead,
because rewriting the answer would falsify the record of what was decided.
