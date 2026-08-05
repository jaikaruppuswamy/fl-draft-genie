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
  "status": "live",              // unsupported|idle|armed|live|degraded|complete|aborted
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

Full state: the status payload plus `picks[]`, `keepers[]`, `teams[]`,
`available[]` (the league board minus everyone drafted and minus keepers,
FR-011 — derived DO-side at snapshot time so a client never reconciles two
sources), and the current `(epoch, seq)`. This is the REST equivalent of the
opening WebSocket frame, and what a client falls back to when the socket is
unavailable.

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
{ "type": "event", "epoch": "uuid", "seq": 413, "revision": 0,
  "kind": "pick_made", "observed_at": "…", "payload": { … } }
{ "type": "status", "epoch": "uuid", "seq": 414, "status": "degraded",
  "staleness": { … } }
```

**Cursor rules** (FR-016/FR-017):

1. The opening frame is **always** a `snapshot`, sent inside the upgrade handler
   *before* the 101 is returned.
2. A client reconnecting with `?since=N` where `epoch` is unchanged and `N` is
   still in the retained window receives `snapshot` + only events `> N`.
   **The retained window is the last 500 events**, held in the session blob
   (`event_window`) — comfortably more than a full draft's stream, so in
   practice a same-epoch cursor is always in range. A cursor **older than the
   window** is not an error: the client receives a full `snapshot` and resets
   its cursor, exactly as in rule 3.
3. **Mismatched or unknown `epoch` ⇒ full snapshot, cursor reset.** The epoch
   changes on every rebuild, which is what stops a stale cursor from silently
   skipping a reconstructed draft.
4. Clients **discard** `seq <= cursor` and resync only on a true forward gap.
   Duplicate frames are possible and must not trigger a resync storm.

**Multiple clients**: every socket on the session receives identical frames with
identical `seq` values. Tabs converge without coordination.

**When Draft Genie itself is unreachable** (distinct from FR-022's ESPN
outage): the client reconnects with exponential back-off 1 s → 2 s → 4 s → …
→ **30 s cap**, and after three consecutive failures falls back to polling
`GET /snapshot` every 15 s until the socket returns. The UI must distinguish
"Draft Genie unreachable" from "ESPN not updating" — the user's remedy differs
(wait vs check ESPN), and during a live draft a wrong diagnosis wastes a pick.

---

## Events consumed by 006 / 008

`pick_made`, `on_deck`, `on_the_clock`, `draft_complete`, `draft_revised` —
payloads in [data-model.md](../data-model.md#events).

Two contract notes that downstream features must code against:

- **`on_deck.picks_until` may be 0.** At snake round boundaries the owner picks
  back-to-back, so `on_deck` and `on_the_clock` fire from the same observation.
  `on_deck` still fires — never suppressed — and 006 pre-computes its second
  pick off `on_the_clock(T)`, not `on_deck(T+1)`.
- **Deduplicate on `(revision, kind, overall)`, not on `seq` or kind alone**
  (FR-019). Exactly-once holds *within* a revision; a correction bumps the
  revision and replays the affected turns, so the same turn event recurs
  legitimately. Treat a bump as "rewind to the correction point and re-apply".
- **Unknown event kinds must be tolerated, not rejected** (FR-006a) — the kind
  set is open so a second draft format can extend it without touching consumers.

## Scheduled job contract (extended)

The existing 5-minute cron gains a draft sweep, running **after** the league
re-sync so a just-published draft time arms on the same tick:

1. Arm sessions for connections whose supported draft is inside the pre-draft
   window.
2. `ensureRunning()` on every row where `archived_at IS NULL AND status NOT IN
   ('aborted','unsupported')` — re-arms the poll alarm only when `getAlarm()` is
   null **AND `completed_at IS NULL`** (FR-014a), and retries a pending archive.
   The second conjunct is load-bearing: completed-but-unarchived rows stay in
   the work-list deliberately, and without it the cron resumes polling a draft
   that has already finished (FR-005/FR-008). `getAlarm()` is evaluated **inside**
   the object under `blockConcurrencyWhile` — a caller cannot use it as a health
   check, because it returns null while the handler is running.
3. Re-arm an `aborted` session whose league snapshot now carries a **different**
   `draft_at` (the rescheduled-draft path). This needs its own query — the
   work-list above deliberately excludes `aborted` — joining `draft_sessions` to
   `league_snapshots.draft_at`.

## Ingest boundary (owned by 010, consumed here)

005 does **not** define the tap's wire format — `010-draft-tap`'s
[contracts/ingest.md](../../010-draft-tap/contracts/ingest.md) does, and it is
authoritative. Two obligations flow the other way, and both are load-bearing:

### `POST /api/tap/batch` — acknowledgement ordering (FR-007h)

The tap discards its buffer **only** on `accepted_through`, so the ack is a
durability boundary:

1. authorise and re-assert the privacy filter
2. `INSERT INTO tap_batches` — the durable commit
3. respond `202 { accepted_through }` — the tap may now forget these messages
4. `ctx.waitUntil(session.nudge())` — **after** the response

The ack MUST NOT be sent before step 2, and MUST NOT wait on step 4.

### `POST /api/tap/status` — periodic heartbeat (FR-007e)

**Shipped in 010 tap 0.1.6.** Before it, the tap posted only on state *change*,
so a healthy tap was silent — the exact case liveness detection must observe.

- interval **15 s**, carrying `{ state, tapVersion, heartbeat, hidden, league }`
- a **45 s** gap is a lapse while `hidden` is false; **150 s** while it is true,
  because a background tab's timers are throttled to ~1/minute and one threshold
  would declare a healthy tap dead
- also sent on `visibilitychange`, `pageshow`, `focus` and `online`, including
  the transition *into* hidden, so the session widens its bound before the
  throttling begins rather than after a false alarm
- a heartbeat **arms** the session if none exists (FR-007g), which is what makes
  a missing tap visible *before* the first pick rather than after it

Liveness MUST NOT be inferred from pick silence: measured gaps run from ~1 s
under autodraft to 90 s+ between human picks.

## Internal RPC (Worker → DO)

`ensureRunning()`, `snapshot()`, `shutdown()`, `nudge()`. Not public API.

`nudge()` carries **no frame data** — only "there is new work". The session
pulls from `tap_batches` by cursor. This is deliberate: frames in the nudge
would make the DO's availability a durability dependency, so a tap that had
already discarded its buffer on the ack could lose picks to an object that was
restarting. A dropped nudge costs latency; the 5 s safety alarm bounds it, and
SC-001's 100%-within-10 s ceiling is enforced by that alarm rather than by
assuming `waitUntil` always runs.

`shutdown()` (deleteAlarm + deleteAll, refuse to re-arm) **must** be called from
`deleteConnection` — re-adding a league mints a new connection UUID and hence a
new DO, and an orphaned session would keep reading D1 and ESPN forever with no
row behind it (research §1).
