# Data Model: Draft Monitor (005)

Two stores with distinct jobs (research §5):

- **Durable Object storage** — the live authority. One JSON blob under key
  `"session"` in the synchronous KV API of a SQLite-backed DO.
- **D1** (migration `0005_draft.sql`) — the cron's work-list plus the
  permanent, ESPN-independent archive.

Derived values are **never stored**: rosters, the unavailable set,
picks-until-my-turn and the remaining pick schedule are computed at read time
from picks + keepers + order.

---

## DO blob: `SessionState`

```jsonc
{
  "format": "snake",                  // FR-006a discriminator; drives nothing else
  "status": "live",                   // unsupported|idle|armed|live|not_receiving|degraded|complete|aborted
  "connection_id": "…", "season": 2026, "my_team_id": 7,
  "epoch": "uuid",                    // regenerated on rebuild; invalidates client cursors
  "seq": 412,                         // monotonic within an epoch
  "revision": 3,                      // increments on each ESPN correction (FR-012)
  "order": { "team_ids": [7,3,11,…], "trust": "observed" },  // observed|projected|unknown
  "picks": [                          // ordered; empty slots are the -1 SENTINEL, never "negative"
    { "overall": 1, "round": 1, "round_pick": 1, "team_id": 3, "player_id": 4362628,
      "keeper": false, "autodrafted": false, "observed_at": "…", "detail": null }
  ],
  "keepers": [ { "team_id": 3, "player_id": 3139477 } ],  // pre-draft rostered (mRoster ∪ keeper picks)
  "teams": [ { "team_id": 3, "name": "…" } ],
  "turn_marks": [24, 25],             // owner turns whose on_deck/on_the_clock already fired
  "event_window": [ /* last 500 events, oldest evicted; backs ?since= resume */ ],
  "feed_cursor": { "received_at": "…", "id": "…" },  // keyset into tap_batches (§ Feed cursor)
  "last_heartbeat_at": "…",           // FR-007e; liveness comes from THIS, not pick silence
  "tap": { "state": "relaying", "version": "0.1.5" },  // last reported by the tap
  "withholding": null,                // null | "not_receiving" | "incompatible" | "version_rejected"
  "last_espn_read_at": "…", "last_success_at": "…", "consecutive_errors": 0,
  "due_at": 1785000000000, "armed_deadline": "…",   // scheduled_at + 6 h
  "last_error": null                  // "espn_unreachable"|"espn_rejected"|"league_not_found"
}
```

**Never present**: `espn_s2`, `SWID`, or anything derived from them (FR-024a).
A test asserts `JSON.stringify(state)` contains neither value, mirroring 001's
SC-005 grep test.

**Size**: a 192-pick draft ≈ 25 KB, far under the SQLite backend's 2 MB
key+value cap.

### `stateFingerprint` (FR-014 identity)

The hash proving a rebuilt state equals an incrementally-built one. **Includes**
picks, keepers, order, status, format, my_team_id. **Excludes** `epoch`, `seq`,
`revision`, `observed_at`, `turn_marks` and the event log — a rebuild collapses
N observations into one and cannot reproduce the original stream (research §7).
This narrowing is deliberate and is what FR-014's tests assert against.

### State transitions

```text
unsupported ← (draft type ≠ snake; terminal, no session opened)
idle ──arm──▶ armed ──inProgress──▶ live ──drafted──▶ complete ──archive──▶ (archived)
              ▲ │                     │
              │ │                     ├─ESPN error×3─▶ degraded ──recovery──▶ live
              │ └─armed_deadline──▶ aborted          └─league_not_found──▶ aborted
              └──── new draft_at published ─────┘
```

`aborted` is **not** terminal for the postponed-draft case: when the league
re-sync publishes a *different* `draft_at`, the cron re-arms. That path needs
its own query, because the main work-list predicate below deliberately excludes
`aborted` — join `draft_sessions` to `league_snapshots.draft_at` and re-arm
where they disagree. `league_not_found` aborts terminally (no re-arm).

`degraded` keeps serving last-known state (FR-022) and is **not** a restore
trigger — the cron distinguishes dead from degraded by `getAlarm()`, never by
timestamp (research §5).

---

## Feed cursor (FR-007h)

The session pulls from `tap_batches` rather than receiving frames inline. The
cursor is a **keyset**, not an offset:

```sql
WHERE account_id = ? AND espn_league_id = ? AND season = ?
  AND (received_at > ?1 OR (received_at = ?1 AND id > ?2))
ORDER BY received_at, id
LIMIT 200
```

- **Keyset, not offset**: a batch inserted mid-read shifts an offset window and
  silently skips a row. The keyset is stable under concurrent inserts.
- **Not "re-read and dedupe"**: the reducer *is* idempotent (FR-010), but that
  should be a safety net, not the mechanism. A design whose correctness depends
  on its own error-tolerance has no margin left when something else goes wrong.
- **Advanced only after the batch is committed to `SessionState`.** A crash
  between read and commit re-reads the same rows, which is safe; a cursor
  advanced first would skip them, which is not.
- Backed by the existing `idx_tap_batches_league`; **no migration needed**.

## The empty-slot sentinel

`playerId === -1` marks an unfilled slot. **Nothing may filter on sign.**

D/ST player ids are legitimately negative — around −16000 — so `playerId > 0`
drops every defence in the draft. This is not hypothetical: that exact predicate
made 010's capture script report 66 of 72 picks for a complete draft, and an
earlier revision of this document carried the same rule. Compare against the
sentinel, never against zero.

## Derived at read time

| Value | Derivation |
|-------|------------|
| Team rosters | `picks ∪ keepers`, grouped by `team_id`, keyed by `player_id` so overlap collapses |
| Available players | 002's league board minus every `player_id` in that union (FR-011) |
| On the clock | `teamAt(frontier)` where frontier = highest observed `overall` + 1 |
| Picks until my turn | `nextOwnerPick − frontier`; **null** when `order.trust === "unknown"` |
| Remaining schedule | every future `overall` where `teamAt(n) === my_team_id` (FR-010) |

`teamAt(n)`: observed `team_id` below the frontier; ESPN's skeleton `team_id`
when present; otherwise the snake projection from `order.team_ids`. `trust`
degrades to `unknown` — baseline cadence, no turn events, dashes in the UI —
rather than fabricating a slot.

---

## D1: `draft_sessions` (cron work-list)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| connection_id | TEXT | PK, REFERENCES league_connections(id) ON DELETE CASCADE | One session per connection per season; season joined from the parent |
| account_id | TEXT | NOT NULL, REFERENCES accounts(id) ON DELETE CASCADE | Per-user isolation on every read (FR-018) |
| status | TEXT | NOT NULL, CHECK IN ('idle','armed','live','degraded','complete','aborted','unsupported') | |
| scheduled_at | TEXT | | Copied from the league snapshot at arm time |
| last_observed_at | TEXT | | Heartbeat, 30 s-throttled. **Diagnostics + 009 alerting only — never a restore trigger** |
| pick_count | INTEGER | NOT NULL DEFAULT 0 | Cheap progress for the diagnostic page |
| completed_at | TEXT | | Set when ESPN reports `drafted` |
| archived_at | TEXT | | NULL ⇒ still in the cron's work-list |

`CREATE INDEX idx_draft_sessions_open ON draft_sessions (archived_at, status);`

Cron predicate: `archived_at IS NULL AND status NOT IN ('aborted','unsupported')`
→ call idempotent `ensureRunning()` on each. Completed-but-unarchived rows stay
in the work-list **for the archive retry only**:

- re-arms the poll alarm **only when `getAlarm()` is null AND `completed_at IS
  NULL`** — without the second condition the cron would resume polling a draft
  that has already finished, contradicting FR-005 and FR-008;
- retries the archive when `completed_at IS NOT NULL AND archived_at IS NULL`.

**Liveness is tested inside the DO, never from outside.** `getAlarm()` returns
null while the alarm handler is running, so a *caller* cannot use it as a health
check. `ensureRunning()` evaluates it inside the object under
`ctx.blockConcurrencyWhile`, where that race does not exist. Persisted
staleness (`last_observed_at`) is **not** a restore trigger — a session degraded
by an ESPN outage is indistinguishable by timestamp from a dead one, so
thresholding it would rebuild live sessions exactly during an outage.

## D1: `draft_picks` + `draft_keepers` (permanent archive)

Written **once** at completion, chunked at 10 rows per statement (D1's
100-bound-parameter cap; ~24 statements for a 192-pick draft in one
`db.batch()`).

`draft_archives` *(the archive header — one row per completed draft)*:
`account_id` (FK → accounts, CASCADE), `connection_id` (plain column, **no
FK**), **`espn_league_id`**, `season`, `league_name`, `team_count`,
`my_team_id`, `order_json`, `teams_json`, `format`, `completed_at`,
`archived_at`. PK `(account_id, connection_id, season)`.

`espn_league_id` is not redundant: once the FK is severed, `connection_id`
resolves to nothing after a disconnect, and re-adding the same league mints a
*new* UUID — so without it 008 cannot tell two archives of the same league
apart except by the mutable, snapshot-copied `league_name`. Index
`(account_id, espn_league_id, season)` for that lookup.

`draft_picks`: `account_id` (FK → accounts, CASCADE), `connection_id` (plain
column, **no FK**), `season`, `overall`, `round`, `round_pick`, `team_id`,
`player_id`, `keeper`, `autodrafted`, `observed_at`, `detail_json`.
PK `(account_id, connection_id, season, overall)`.

`draft_keepers`: same key columns plus `team_id`, `player_id`.

**Cascade decision**: all three archive tables key on `account_id` and
deliberately carry **no foreign key to `league_connections`**, so disconnecting
a league does not delete its draft history — FR-013 forbids removal, and 008's
replay corpus must survive. Deleting an *account* still removes everything.

**Replay sufficiency (FR-013)**: `league_snapshots` is one row per connection,
**overwritten on every re-sync**, so the archive cannot reference it — and
neither can `draft_sessions`, which cascades from `league_connections` and dies
with a disconnect. `my_team_id`, `order_json` and `teams_json` are therefore
copied into **`draft_archives`**, on the account-keyed side of the cascade
boundary. Putting them in `draft_sessions` would silently defeat the very
cascade decision above.

`observed_at` is **first-seen-wins** (`ON CONFLICT DO UPDATE` that never
overwrites it), because a cold rebuild would otherwise stamp every pick with one
timestamp and destroy the per-pick timing 008 wants.

---

## Events

| Kind | Payload |
|------|---------|
| `pick_made` | the pick, plus resulting `pick_count` and frontier |
| `on_deck` | `overall`, and the **actual** `picks_until` (2, 1 or **0**) |
| `on_the_clock` | `overall`, `remaining_schedule` |
| `draft_complete` | final `pick_count`, `completed_at` |
| `draft_revised` | `from_overall`, `revision` — a correction, never a retraction (FR-012) |

Every event carries `(epoch, seq, revision, observed_at)`. Events sharing an
`observed_at` came from one observation — that is how a collapsed batch is
distinguished from a live sequence (FR-020a).

**Exactly-once is scoped per revision** (FR-019). Consumers deduplicate on
`(revision, kind, overall)`. A correction bumps `revision` and replays the
turns above the correction point under the new number, so the same
`on_the_clock(25)` legitimately appears twice across a draft's lifetime with
different revisions — a consumer treating a bump as "rewind and re-apply" gets
the right answer; one assuming per-draft uniqueness recommends into a pick that
has already been made.

**`picks_until` may legitimately be 0.** In a 12-team snake the slot-1 and
slot-12 owners pick back-to-back at every round turn (#24 then #25), so there is
no state where the owner is two picks from #25 and not already on the clock for
#24. `on_deck` still fires — never skipped — but with zero lead time. **006 must
read `picks_until` and pre-compute its second pick off `on_the_clock(T)` rather
than waiting for `on_deck(T+1)`.**
