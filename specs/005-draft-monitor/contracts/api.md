# API Contract: Draft Monitor (005)

All routes sit under the existing session-authenticated `/api/*` middleware
(`src/api/app.ts:34-42`) and are scoped to a connection the caller owns —
a connection belonging to another account returns **404**, never 403 (FR-018,
matching 001/002 house style).

The WebSocket path must stay under `/api/` so `wrangler.jsonc`'s existing
`run_worker_first` rule routes it to the Worker rather than the SPA fallback.

---

## GET /api/leagues/:id/draft

Session status for the diagnostic page and for 007 later.

```jsonc
{
  "status": "live",              // unsupported|idle|armed|live|degraded|complete
  "format": "snake",
  "scheduled_at": "2026-08-30T23:00:00Z",
  "order": { "team_ids": [7,3,11], "my_slot": 1, "trust": "observed" },  // team_ids null until published
  "pick_count": 24,
  "on_the_clock": { "team_id": 11, "overall": 25 },
  "picks_until_my_turn": 3,      // null when order.trust === "unknown"
  "remaining_schedule": [28, 45, 52],
  "staleness": { "last_success_at": "…", "age_seconds": 4, "degraded": false },
  "last_error": null             // "espn_unreachable"|"espn_rejected"|"league_not_found"
}
```

- `status: "unsupported"` for auction/offline drafts — the only fields
  guaranteed alongside it are `format` and `scheduled_at` (FR-006).
- `staleness.degraded` true means last-known state is being served during an
  ESPN outage (FR-022); the payload is still complete, just aging.
- `last_error: "espn_rejected"` is the credential case (FR-023) and the client
  links to credential re-entry — distinct from an outage.

## GET /api/leagues/:id/draft/snapshot

Full state: the status payload plus `picks[]`, `keepers[]`, `teams[]`, and the
current `(epoch, seq)`. This is the REST equivalent of the opening WebSocket
frame, and what a client without WebSocket support falls back to.

## POST /api/leagues/:id/draft/open

Idempotent on-demand start (FR-002). Arms or resumes the session and returns the
same body as `GET`. Never opens a session for an unsupported format.

---

## GET /api/leagues/:id/draft/stream  (WebSocket)

Upgrade endpoint. The Worker authenticates the cookie at the edge, resolves
ownership, then calls the DO with a **synthesized** request carrying no cookie —
the DO never sees credentials or session tokens (research §3).

**Query**: `?since=<seq>` — omit on first connect.

**Direction**: strictly **server → client**. Client frames are ignored; the
protocol has no client commands (Constitution VI keeps this one-way by design).

**Frames**:

```jsonc
{ "type": "snapshot", "epoch": "uuid", "seq": 412, "state": { … } }   // always first
{ "type": "event", "epoch": "uuid", "seq": 413, "kind": "pick_made",
  "observed_at": "…", "payload": { … } }
{ "type": "status", "epoch": "uuid", "seq": 414, "status": "degraded",
  "staleness": { … } }
```

**Cursor rules** (FR-016/FR-017):

1. The opening frame is **always** a `snapshot`, sent inside the upgrade handler
   *before* the 101 is returned.
2. A client reconnecting with `?since=N` where `epoch` is unchanged and `N` is
   still in the retained window receives `snapshot` + only events `> N`.
3. **Mismatched or unknown `epoch` ⇒ full snapshot, cursor reset.** The epoch
   changes on every rebuild, which is what stops a stale cursor from silently
   skipping a reconstructed draft.
4. Clients **discard** `seq <= cursor` and resync only on a true forward gap.
   Duplicate frames are possible and must not trigger a resync storm.

**Multiple clients**: every socket on the session receives identical frames with
identical `seq` values. Tabs converge without coordination.

---

## Events consumed by 006 / 008

`pick_made`, `on_deck`, `on_the_clock`, `draft_complete`, `draft_revised` —
payloads in [data-model.md](../data-model.md#events).

Two contract notes that downstream features must code against:

- **`on_deck.picks_until` may be 0.** At snake round boundaries the owner picks
  back-to-back, so `on_deck` and `on_the_clock` fire from the same observation.
  006 pre-computes its second pick off `on_the_clock(T)`, not `on_deck(T+1)`.
- **Unknown event kinds must be tolerated, not rejected** (FR-006a) — the kind
  set is open so a second draft format can extend it without touching consumers.

## Scheduled job contract (extended)

The existing 5-minute cron gains a draft sweep, running **after** the league
re-sync so a just-published draft time arms on the same tick:

1. Arm sessions for connections whose supported draft is inside the pre-draft
   window.
2. `ensureRunning()` on every row where `archived_at IS NULL AND status NOT IN
   ('aborted','unsupported')` — re-arms only when `getAlarm()` is null (FR-014a),
   and retries a pending archive.

## Internal RPC (Worker → DO)

`ensureRunning()`, `snapshot()`, `shutdown()`. Not public API.
`shutdown()` (deleteAlarm + deleteAll, refuse to re-arm) **must** be called from
`deleteConnection` — re-adding a league mints a new connection UUID and hence a
new DO, and an orphaned session would keep polling ESPN forever with no D1 row
behind it (research §1).
