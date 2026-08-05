# Implementation Plan: Draft Monitor

**Branch**: `005-draft-monitor` | **Date**: 2026-08-05 (round 4 rewrite) | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-draft-monitor/spec.md`

> **This plan was rewritten after Gate 0 failed and `010-draft-tap` shipped.**
> The previous version architected a polling loop against `mDraftDetail`; 207
> samples across ~30 real picks proved that view frozen during a live draft, and
> `mRoster`/`mTeam` are no better — ESPN writes the draft to its league database
> once, at completion. Picks now arrive by ingest from the browser tap. The
> server-side half of the old plan — the reducer, the snake projection, the event
> model, WebSocket delivery, the D1 archive — survives intact. The intake half is
> replaced.

## Summary

A `DraftSession` Durable Object per league connection per season remains the
sole authority for live draft state. It is no longer fed by polling ESPN: the
tap's ingest route writes accepted frames to a durable server-side log
(`tap_batches`), acknowledges, and then **nudges** the session, which **pulls**
from that log by cursor. The same pure `reconcile()` reducer turns each batch
into ordered events (`pick_made`, `on_deck`, `on_the_clock`, `draft_complete`),
and hibernatable WebSockets fan state out to browsers behind a
snapshot-then-cursor hand-off. D1 holds a session header row plus a permanent
archive written once at completion. A deliberately plain diagnostic page proves
it works; 007 replaces that page wholesale.

**Gate 0 is closed** (failed, 2026-08-03) and no longer opens implementation.
The premise it was built to test is disproven, the replacement transport is
built and deployed, and this feature is written against **real captured frames**
— a 617-frame corpus and a 72-message live relay — rather than a protocol guess.

## Technical Context

**Stack**: unchanged (Workers / Hono / D1 / React) plus **one new platform
primitive — Durable Objects**. No new npm dependencies.

### The feed: notify-then-pull (FR-007h)

This is the one genuinely new mechanism, and its shape is fixed by a
constraint that is easy to miss: **the tap discards its local buffer only when
the server returns `accepted_through`**. That makes the acknowledgement a
durability boundary, not a courtesy.

```text
tap ──POST /api/tap/batch──▶ Worker
                              1. authorise, re-assert the privacy filter
                              2. INSERT INTO tap_batches        ← durable commit
                              3. 202 { accepted_through }       ← tap may now forget
                              4. ctx.waitUntil(session.nudge()) ← after the ack
                                            │
                              DraftSession ◀┘
                                 pulls tap_batches by cursor, reduces, fans out
```

Three properties this buys, each of which a naive design loses:

- **The ack never waits on the session.** A restarting, migrating or
  briefly-unavailable DO cannot stall the tap's buffer — the outcome FR-008's
  buffering guarantees exist to prevent.
- **Nothing is lost if the nudge is.** The nudge carries no data, only "there is
  new work". The log is the source of truth, so a dropped nudge costs latency,
  never a pick.
- **The recovery path is the only path.** Rebuilding a dead session replays the
  same log through the same cursor read. There is no separate, rarely-exercised
  restore routine to rot — which is what round 3 meant by making the persisted
  log the automatic rebuild path.

**Cursor**: keyset on `(received_at, id)`, ordered, over the existing
`idx_tap_batches_league` index — `WHERE account_id = ? AND espn_league_id = ?
AND season = ? AND (received_at > ?1 OR (received_at = ?1 AND id > ?2))`. No
migration is required for the feed; `tap_batches` is already shaped for it.
A keyset cursor is chosen over an offset so that a batch inserted during a read
cannot shift the window, and over "dedupe on re-read" so that correctness does
not depend on the reducer's idempotency — that idempotency is a safety net here,
not the mechanism.

**Safety alarm**: 5 s while the room is open. SC-001 promises **100% within
10 s**, and a lost nudge must not breach it — so the ceiling is enforced by a
timer rather than by hoping `waitUntil` always runs. This alarm makes no
external request; it is a D1 cursor read.

### Liveness: heartbeat, not silence (FR-007e)

Pick silence is not evidence. Measured across real drafts: **~1 s** between
autodrafted picks and **90 s+** between human ones, so no silence threshold
separates a slow draft from a dead tap.

- The tap posts a **heartbeat every 15 s** carrying its state and version.
- **Lapse = 45 s** without one (three intervals, so a single dropped request is
  not an alarm).
- A **15 s liveness alarm** evaluates the lapse, so detection lands well inside
  SC-001b's 30 s.

> ⚠️ **Cross-feature dependency**: 010's tap reports only on state *change*, so a
> healthy tap is currently silent. The periodic heartbeat is a change **in 010**,
> tracked as 005 FR-007e and recorded in ROADMAP. 005 cannot satisfy FR-007c
> without it.

### Arming (FR-007g)

The **first frame from a tap arms the session** — heartbeat included. Because
the tap heartbeats from the moment the draft room opens, the session exists
*before the first pick*, so a missing or broken tap is visible while there is
still time to fix it. On arming, the session fetches the pre-draft data ESPN
still exposes (draft type, scheduled time, published order, teams): Gate 0
disproved live pick visibility, **not** pre-draft reads.

### ESPN's post-completion flush as a production oracle

The one thing Gate 0 proved ESPN *does* write reliably is the **completed**
draft. 010 used that as an independent oracle in tests — it is what disproved
the field-3 reading (5/70) and confirmed the ledger offsets (31/31).

This plan promotes it to a **production correctness check**: on `drafted`, the
session fetches the authoritative `mDraftDetail` and reconciles the tap-built
draft against it before archiving. Divergence bumps the revision through the
existing correction path (FR-012/FR-019). Every archived draft is therefore
verified against a source that did not produce it — the strongest available
check that the tap missed nothing, at a cost of one request per draft.

**Storage**: DO SQLite-backed storage is the live authority; D1 migration
`0008_draft.sql` adds `draft_sessions` (cron work-list, cascades from
`league_connections`) and the permanent **three-table** archive
`draft_archives` + `draft_picks` + `draft_keepers` — all keyed by `account_id`,
cascading from `accounts`, none carrying an FK to `league_connections`, so
disconnecting a league does not destroy retained history (research §5).
Numbered `0008` because 010 took `0006` and `0007`.

**Transport**: WebSocket Hibernation API (`ctx.acceptWebSocket`) — still
mandatory, though for a different reason than before. The old plan needed
`ctx.getWebSockets()` to drive an attended/unattended *cadence flip*; there is
no cadence any more. It is now required because the session must survive
eviction between picks while keeping client sockets attached, and because
`server.accept()` sockets are invisible to `ctx.getWebSockets()` and so cannot
be enumerated after a restart.

**External calls** (much reduced — FR-008): `mSettings` + `mTeam` + `mRoster` at
arm, rebuild and state transitions; a slow **60 s** `mDraftDetail` poll while the
room is open, purely to observe the `inProgress`/`drafted` flags; one
`mDraftDetail` read at completion for the oracle above. **Zero ESPN requests sit
on the pick path.**

**Documented ESPN rate bound (FR-008, validated by SC-008)**:

- **≤ 5 requests per minute per league**, and at most one in flight per session.
  The old bound was 25/min, sized around a 3 s poll tier that no longer exists;
  the new pattern's busiest minute is an arm (3 reads) overlapping one liveness
  poll. Stating 25 now would document headroom the design cannot use.
- **Back-off ladder** on consecutive errors: 5 s → 10 s → 20 s → 40 s → **60 s
  cap**, reset on first success. `espn_rejected` climbs the same ladder;
  `league_not_found` (404) goes terminal rather than hammering a 404 forever.
- **No ESPN polling at all** in `complete`, `aborted` or `unsupported`.

**Armed absolute deadline (FR-002 / postponed-draft edge case)**:
`scheduled_at + 6 hours`, then `aborted`. Re-arm is not manual — the cron
re-arms when a league re-sync publishes a different `draft_at`.

**Performance**: **p95 ≤ 2 s, 100% ≤ 10 s** from the tap's `observed_at` to
client delivery (SC-001, ratified round 4). Measured end-to-end across a real
72-pick draft with the shipped tap: **median 0.202 s, p95 0.223 s, max 0.900 s**,
72/72 under 3 s. The budget therefore sits roughly 10× above observed p95 —
deliberate headroom for a congested draft-night network, not a number tuned to a
good day. There are no tiers, because the tap pushes at one rate regardless of
whose turn it is, and no 60 s failover ceiling, because no polling timer remains
to be delayed.

**Cost**: materially better than the polling design on the ESPN axis (zero
requests per pick) and unchanged on the DO axis: the 5 s / 15 s alarms keep the
object resident while a room is open, so a 3-hour draft still bills ≈ 1,382 GB-s.
Alarms are scheduled **only while the room is open** — armed and completed
sessions schedule nothing, which is what keeps a postponed draft from burning
~11,000 GB-s/day.

**Testing**: Vitest, now **three projects** under one `npm test` — the existing
workers pool, the `node` project 010 added for `tap/**`, and a new root-level
config for `tests/draft/**` with `isolatedStorage: false` (WebSockets in DOs are
unsupported with per-file isolation). The workers config's include glob matches
`tests/draft/**`, so it must gain a matching **exclude** or every DO test also
runs under the isolated-storage project that cannot support it. Bulk logic is
tested through the pure reducer, DO-free; the feed is tested by writing rows to
`tap_batches` and asserting what the session pulls; ESPN is faked with
`fetchMock` + `disableNetConnect()`, which is what makes SC-008 structural.

**Replay corpus**: 010 committed `tests/fixtures/tap/replay-full.jsonl` (72 live
messages) and `oracle-live-2026.json`. SC-010 replays the former and compares
against the latter — a corpus produced by a different mechanism than the one
under test, which is what makes the check meaningful.

**Known dependency bump**: `evictDurableObject` is still absent from the
installed `@cloudflare/vitest-pool-workers@0.8.71` (verified 2026-08-05). Bump
before writing the FR-017 eviction test, not after.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I Spec-first | PASS | Spec + 4 ratified clarification rounds + two adversarial reviews precede this plan; the plan was rewritten rather than patched when its premise fell |
| II Any-league | PASS | Session keyed by connection id; draft type, order and team count read from the league's own ESPN settings; nothing hardcoded |
| III League currency | PASS | This feature computes no points. The available-player set defers to 002's per-league board |
| IV Rules are code | PASS | Heartbeat interval, lapse threshold, back-off ladder, `on_deck` threshold and reconciliation are constants and code — no settings surface |
| V Draft day | PASS | The durable log is written before the ack, so a session crash cannot lose a pick the tap has already discarded; cron restores dead sessions without a client; rebuild replays the same log the live path reads; snapshot-then-cursor reconnect |
| VI Read-only | PASS | ESPN sees only GET reads through the existing client, and **fewer** than the polling design. The tap opens no connection to ESPN and has no send path (010, asserted against the shipped artifact) |
| VII Explainable | N/A | No recommendations in this feature — 006 owns it. FR-007f decides only *when to withhold* |
| VIII Simplicity | PASS (1 justified addition) | One new primitive (DO), one new migration, one new module tree, zero new dependencies. The feed adds no queue, no new service and no new binding beyond the DO itself |

**Post-Phase-1 re-check**: PASS. The design added no services, no config
surfaces and no user-facing knobs. Two deliberate narrowings are documented
rather than left implicit: FR-014's "identical rebuilt state" is defined over a
`stateFingerprint` that excludes the delivery cursor and event log (a rebuild
collapses N observations into one and provably cannot reproduce the original
event stream — research §7), and FR-007f's withholding rule deliberately does
**not** fire on `buffering`, because a tap correctly riding out an outage still
holds every pick.

## Project Structure

### Documentation (this feature)

```text
specs/005-draft-monitor/
├── plan.md, research.md, data-model.md, quickstart.md
├── contracts/api.md          # HTTP + WebSocket protocol
├── checklists/requirements.md
└── tasks.md (next phase — regenerated for this plan)
```

### Source Code (additions)

```text
migrations/0008_draft.sql
src/draft/
├── session.ts          # DraftSession DO: nudge/pull, alarms, WS hibernation, RPC
├── feed.ts             # PURE cursor arithmetic + batch→observation mapping
├── reconcile.ts        # PURE reducer: observation → (state, events). No platform deps
├── liveness.ts         # PURE heartbeat lapse + withholding rules (FR-007c/e/f)
├── schedule.ts         # PURE ESPN refresh cadence + back-off ladder (replaces cadence.ts)
├── snake.ts            # PURE order projection, teamAt(n), remaining schedule, orderTrust
└── archive.ts          # completion → oracle reconcile → D1 archive
src/espn/
├── types.ts            # (extend) completed draftDetail.picks[], mRoster entries
└── parsers.ts          # (extend) parseCompletedDraft() for the oracle check
src/api/tap.ts          # (extend) nudge the session after the ack; heartbeat route
src/db/draft.ts         # draft_sessions header, archive reads/writes
src/db/tap.ts           # (extend) cursor read over tap_batches
src/api/draft.ts        # session status, snapshot, WS upgrade proxy
src/api/app.ts          # (extend) mount /api/leagues/:id/draft
src/db/leagues.ts       # (extend) deleteConnection calls shutdown() RPC
src/sync/predraft.ts    # (extend) restore sweep on the 5-minute cron
src/index.ts            # (extend) re-export DraftSession
src/env.ts              # (extend) DRAFT_SESSION binding
wrangler.jsonc          # durable_objects binding + legacy `migrations` array
web/src/pages/DraftDiagnostics.tsx   # throwaway plain page (FR-025)
web/src/lib/draftSocket.ts           # reconnect + cursor resume
vitest.draft.config.ts               # third project, isolatedStorage: false
tests/draft/*.test.ts                # DO, alarm, WebSocket, feed
tests/unit/{reconcile,liveness,snake,feed,schedule}.test.ts
```

**Structure Decision**: same single-Worker layout. `src/draft/` mirrors
`projections/`, `tiers/` and `signals/`, with the deliberate rule that
`feed.ts`, `reconcile.ts`, `liveness.ts`, `schedule.ts` and `snake.ts` import
**nothing from the platform** — that is what makes FR-021 (offline replay) true
by construction and keeps the DO a thin shell around tested logic. 010 proved
the value of that rule the hard way: its draft-end detection was four lines
inside the impure shell, where nothing could test it, and it shipped wrong in
two ways a single test would have caught.

> **`wrangler.jsonc` must use the legacy `migrations` array, not `exports`.**
> 010's research established empirically that `exports` silently provisions a
> KV-backed DO under the installed vitest pool while production is SQLite-backed
> — the tests would pass against a different storage engine than production runs.

## Implementation Phases

**Phase A — pure core.** `reconcile.ts`, `snake.ts`, `feed.ts`, `liveness.ts`,
`schedule.ts` + unit tests against the committed frame corpus. Delivers SC-010's
replay check against the independent oracle with no DO in sight.

**Phase B — the session and the feed.** DO, nudge/pull, cursor, D1 header, lazy
arming, safety alarm, rebuild-from-log. Delivers US1/US3 state, FR-007g/h and
FR-014/FR-014a. **This is the phase whose correctness is hardest to see**, so it
is the phase whose tests are written first.

**Phase C — liveness and delivery.** Heartbeat ingestion, lapse detection,
withholding, WebSocket upgrade, snapshot-then-cursor, client reconnect,
diagnostic page. Delivers US2's reload survival, FR-007c/e/f and FR-025.

**Phase D — archive + hardening.** Completion oracle reconcile, archive,
`shutdown()` on disconnect, credential-sweep test, absolute armed deadline.

**Blocked on 010**: FR-007e's heartbeat. Phase C's lapse detection can be built
and tested against synthesised heartbeats, but cannot be validated end-to-end
until the tap emits them.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New platform primitive: Durable Objects | Single-writer authority per league with live WebSockets and a sub-minute durable timer. Nothing else on Workers offers all three | Stateless Workers cannot hold the reduced state or push to clients; D1 + client polling violates FR-015 and dies when the tab closes |
| Third Vitest project config | WebSockets in DOs are unsupported with per-file storage isolation, which the existing suite depends on | One config means either no WebSocket tests, or turning isolation off for the whole suite and making every current D1 test share state |
| Nudge + pull rather than passing frames inline | FR-007h forbids the ack waiting on the session, and a dropped nudge must not lose a pick | Passing frames in the nudge makes the DO's availability a durability dependency — the tap would discard picks the session never received. A queue would add a binding and a second delivery system for no gain over a log the feature already writes |
