# Implementation Plan: Draft Monitor

**Branch**: `005-draft-monitor` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-draft-monitor/spec.md`

## Summary

A `DraftSession` Durable Object per league connection per season is the sole
authority for live draft state. One self-rescheduling alarm polls ESPN's
`mDraftDetail` at the ratified tiers (3 s / 10 s / 30 s / 60 s armed), a pure
`reconcile()` reducer turns each observation into ordered events
(`pick_made`, `on_deck`, `on_the_clock`, `draft_complete`), and hibernatable
WebSockets fan state out to browsers behind a snapshot-then-cursor hand-off.
D1 holds a session header row that the existing 5-minute cron uses as its
work-list (arming and restoring dead sessions) plus a permanent archive
written once at completion. A deliberately plain diagnostic page proves it
works; 007 replaces that page wholesale.

**Gate 0 first**: implementation opens with an empirical capture of a real
ESPN draft, because the premise that `mDraftDetail` updates *during* a draft
is not established (research §0). Everything else is written against the
fixtures that capture produces.

## Technical Context

**Stack**: unchanged (Workers / Hono / D1 / React) plus **one new platform
primitive — Durable Objects**. No new npm dependencies.

**Storage**: DO SQLite-backed storage (synchronous KV blob) is the live
authority; D1 migration `0005_draft.sql` adds `draft_sessions` (cron
work-list, cascades from `league_connections`) and the permanent **three-table**
archive `draft_archives` + `draft_picks` + `draft_keepers` (all keyed by
`account_id`, cascading from `accounts`, none carrying an FK to
`league_connections` — so disconnecting a league does not destroy retained
history, research §5). `draft_archives` is where `my_team_id`, `order_json` and
`teams_json` live: putting them in `draft_sessions` would put them back on the
cascade path and defeat FR-013.

**Transport**: WebSocket Hibernation API (`ctx.acceptWebSocket`) — mandatory,
not optional: `ctx.getWebSockets()` returns 0 for `server.accept()` sockets,
so FR-007a's attended/unattended cadence flip cannot otherwise be implemented.

**External calls**: `?view=mDraftDetail` alone on the live poll path;
`mSettings` + `mTeam` + `mRoster` at arm, rebuild and state transitions.
`mRoster` is new to this repo (keepers, research §4).

**Documented ESPN rate bound (FR-008, validated by SC-008)** — the number
FR-008 requires and the spec deliberately left to the plan:

- **≤ 25 requests per minute per league**, and **at most one request in flight
  per session** (the single in-flight gate is also correctness, not just
  politeness — research §7). The 3 s tier alone is 20 `mDraftDetail` polls/min;
  the headroom covers a rebuild or state transition landing in the same minute,
  which adds `mSettings` + `mTeam` + `mRoster`. A flat 20 would be breached by
  the plan's own request pattern.
- **Back-off ladder** on consecutive errors: 5 s → 10 s → 20 s → 40 s → **60 s
  cap**, reset to the normal tier on the first success. `espn_rejected`
  (credentials) climbs the same ladder; `league_not_found` (404) does **not** —
  it goes terminal, or the session hammers a 404 forever.
- **No polling at all** in `complete`, `aborted` or `unsupported` — the alarm
  is not rescheduled, and `ensureRunning()` will not re-arm a completed
  session.

**Armed absolute deadline (FR-002 / postponed-draft edge case)**:
`scheduled_at + 6 hours`, then `aborted`. Re-arm is not manual — the cron
re-arms when the league re-sync publishes a *different* `draft_at`, which is
how a rescheduled draft comes back without the owner doing anything.

**Performance**: pick visible ≤ 12 s attended baseline / ≤ 4 s inside the
3-pick tier at the **95th percentile**, with 100% inside the tier bound + 60 s
(SC-001, ratified in clarification round 2). The ceiling exists because
Cloudflare documents alarms as delayable by up to a minute during failover —
the spec now states a percentile plus a ceiling rather than an absolute the
platform does not offer, and T048 measures both over the replayed draft.

**Cost**: a polling DO does not hibernate (10 s of no events required; the
baseline tier sits exactly at that threshold), so a 3-hour draft bills ≈
1,382 GB-s of duration. Fine per draft; the postponed-draft edge case needs a
**hard absolute deadline** rather than an indefinite heartbeat, or one stuck
armed session burns ~11,000 GB-s/day.

**Testing**: Vitest workers pool, **two projects** under one `npm test` — plus
a root-level config for `tests/draft/**` with `isolatedStorage: false`
(WebSockets in DOs are unsupported with per-file isolation). The existing
config is **not** untouched: its include glob is already
`tests/**/*.test.ts`, which matches `tests/draft/**`, so it must gain a
matching **exclude** or every DO test also runs under the isolated-storage
project that cannot support it. Bulk logic is tested through the pure reducer,
DO-free; ESPN is faked with `fetchMock` + `disableNetConnect()`, which is what
makes SC-008 structural.

**Fixture sanitization (constitution: Security & Privacy)**: ESPN's
`mSettings`/`mTeam` payloads carry `members[].id` and `teams[].owners[]`, which
**are SWID GUIDs**, plus real names. Every captured fixture is sanitized on
write against the placeholder mapping already fixed by
`tests/fixtures/espn/README.md` (001's house norm) before it reaches the repo.

**Known dependency bump**: `evictDurableObject` is absent from the installed
`@cloudflare/vitest-pool-workers@0.8.71`; bump before writing the FR-017
eviction test, not after.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I Spec-first | PASS | Spec + 5 ratified clarifications + adversarial review precede this plan |
| II Any-league | PASS | Session keyed by connection id; draft type, order, team count all read from the league's own ESPN settings; nothing hardcoded |
| III League currency | PASS | This feature computes no points. The available-player set defers to 002's per-league board |
| IV Rules are code | PASS | Cadence tiers, `on_deck` threshold, back-off ladder and reconciliation are constants and code — no settings surface |
| V Draft day | PASS | Safety alarm armed before the fallible poll; `alarm()` total; cron restores dead sessions without a client; rebuild-from-ESPN; snapshot-then-cursor reconnect |
| VI Read-only | PASS | `mDraftDetail`/`mRoster` are GET reads through the existing read-only client; `disableNetConnect()` makes "zero writes" structural in test. The ESPN draft-room WebSocket is explicitly **not** adopted (research §0) |
| VII Explainable | N/A | No recommendations in this feature — 006 owns it |
| VIII Simplicity | PASS (1 justified addition) | One new primitive (DO), one new migration, one new module tree, zero new dependencies. See Complexity Tracking |

**Post-Phase-1 re-check**: PASS. The design added no services, no config
surfaces and no user-facing knobs. The one deliberate narrowing — FR-014's
"identical rebuilt state" defined over a `stateFingerprint` that excludes the
delivery cursor and event log — is documented in research §7 and
data-model.md rather than left implicit, because a rebuild collapses N
observations into one and provably cannot reproduce the original event stream.

## Project Structure

### Documentation (this feature)

```text
specs/005-draft-monitor/
├── plan.md, research.md, data-model.md, quickstart.md
├── contracts/api.md          # HTTP + WebSocket protocol
├── checklists/requirements.md
└── tasks.md (next phase)
```

### Source Code (additions)

```text
migrations/0005_draft.sql
src/draft/
├── session.ts          # DraftSession DO: alarm loop, WS hibernation, RPC surface
├── reconcile.ts        # PURE reducer: observation → (state, events). No platform deps
├── cadence.ts          # PURE nextPollDelayMs() over the four tiers + back-off ladder
├── snake.ts            # PURE order projection, teamAt(n), remaining schedule, orderTrust
└── archive.ts          # completion → D1 archive (chunked batch, first-seen-wins)
src/espn/
├── types.ts            # (extend) draftDetail.picks[], mRoster roster entries
├── parsers.ts          # (extend) parseDraftObservation()
└── client.ts           # (extend) mRoster view
src/db/draft.ts         # draft_sessions header, archive reads/writes
src/api/draft.ts        # session status, snapshot, WS upgrade proxy
src/api/app.ts          # (extend) mount /api/leagues/:id/draft
src/db/leagues.ts       # (extend) deleteConnection calls shutdown() RPC
src/sync/predraft.ts    # (extend) arm + restore sweep on the 5-minute cron
src/index.ts            # (extend) re-export DraftSession
src/env.ts              # (extend) DRAFT_SESSION binding
wrangler.jsonc          # durable_objects binding + new_sqlite_classes migration
web/src/pages/DraftDiagnostics.tsx   # throwaway plain page (FR-025)
web/src/lib/draftSocket.ts           # reconnect + cursor resume
vitest.draft.config.ts               # second project, isolatedStorage: false
tests/draft/*.test.ts                # DO, alarm, WebSocket
tests/unit/reconcile.test.ts, cadence.test.ts, snake.test.ts
tests/fixtures/espn/draft/*.json     # Gate 0 capture: 4 moments + full replay corpus
```

**Structure Decision**: same single-Worker layout. `src/draft/` mirrors
`projections/`, `tiers/` and `signals/`, with the deliberate rule that
`reconcile.ts`, `cadence.ts` and `snake.ts` import **nothing from the
platform** — that is what makes FR-021 (offline replay) true by construction
and keeps the DO a thin shell around tested logic.

## Implementation Phases

**Gate 0 — validate the premise.** Capture a real ESPN draft by **sampling
continuously at ≤ 5 s for the whole draft** (retaining the four landmarks:
order published + skeleton, room open, mid-draft, complete) — SC-003 and
SC-010 are defined over a continuous observation sequence, and a sparse capture
collapses every event into batches. Fixtures are sanitized on write. If
`mDraftDetail` proves frozen during live drafts, **stop** and return to
`/speckit-clarify`: SC-001 is unachievable by polling, and the alternative
transport carries a Constitution VI question this plan does not answer.

**Phase A — pure core.** `reconcile.ts`, `cadence.ts`, `snake.ts` + unit tests
against the captured fixtures. Delivers SC-010's replay check with no DO.

**Phase B — the session.** DO, alarm loop, D1 header, cron arm/restore,
rebuild. Delivers US1/US3 state and FR-014/FR-014a.

**Phase C — delivery.** WebSocket upgrade, snapshot-then-cursor, client
reconnect, diagnostic page. Delivers US2's reload survival and FR-025.

**Phase D — archive + hardening.** Completion archive, `shutdown()` on
disconnect, credential-sweep test, absolute armed deadline.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New platform primitive: Durable Objects | Nothing else on Workers can hold a sub-minute durable timer *and* live WebSockets *and* single-writer state per league. Ratified in 001 | Cron-only polling floors at 1 minute — ~20× slower than the ratified 3 s tier, and unable to push. D1 + client-driven polling violates FR-015 and dies when the tab closes (FR-007a) |
| Second Vitest project config | WebSockets in DOs are unsupported with per-file storage isolation, which the existing suite depends on | One config for everything means either no WebSocket tests, or turning isolation off for the whole existing suite and making every current D1 test share state |
