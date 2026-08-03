# Quickstart & Validation: Draft Monitor (005)

Builds on the running 001–004 app. Contracts: [contracts/api.md](contracts/api.md).
Design rationale and platform gotchas: [research.md](research.md).

## Setup

```bash
npm run migrate:local
npm run build && npm run dev
```

`wrangler dev` provisions the `DRAFT_SESSION` Durable Object locally from the
`new_sqlite_classes` migration. If alarms stop firing after a hot reload,
restart `wrangler dev` — a known local quirk, not a bug in the session.

## Gate 0 — validate the premise (do this first)

Everything below assumes ESPN's `mDraftDetail` reflects picks *during* a draft.
That is **not established** (research §0). Before building, capture a real
draft — a mock draft in any connected league is enough:

```bash
npx tsx scripts/capture-draft.ts --connection <id> --out tests/fixtures/espn/draft
```

Capture four moments: **order published + skeleton**, **room open**
(`inProgress:true`, zero filled picks), **mid-draft**, **complete**.

**Pass**: pick count grows between mid-draft captures → proceed.
**Fail**: the view is frozen and flushes at completion → **stop**. SC-001 is
unachievable by polling; return to `/speckit-clarify` with the capture, because
the alternative transport raises a Constitution VI question this plan does not
answer.

## Validation scenarios

1. **Live tracking (US1, SC-001)** — replay the captured mid-draft sequence
   through a session: each pick appears with round / overall / team / player,
   the drafted player leaves the available set, and the on-the-clock team and
   picks-until-my-turn advance.
2. **Keepers (US1 AS4, FR-011)** — a keeper-league fixture shows pre-draft
   rostered players as unavailable and attributed, counted **once** even though
   they appear both in `picks[]` and in `roster.entries[]`.
3. **Reload survival (US2 AS1, SC-004)** — reload the diagnostic page mid-replay:
   full state returns in under 3 s with zero missing picks, via
   `snapshot` + `?since=`.
4. **Rebuild from ESPN (US2 AS2, SC-005)** — destroy the DO mid-draft; the next
   `ensureRunning()` rebuilds from ESPN alone and `stateFingerprint` matches the
   pre-crash value. Note the rebuilt `epoch` differs — connected clients take a
   fresh snapshot, by design.
5. **Unattended recovery (FR-014a, SC-005)** — destroy the session with **no
   client connected**; the 5-minute cron restores it with no client action.
6. **Cadence (FR-007/FR-007a)** — with `vi.useFakeTimers({ toFake: ['Date'] })`:
   30 s unattended, 10 s with a socket attached, 3 s once within 3 picks of the
   owner's turn. Assert via `getAlarm()`, never wall-clock.
7. **Outage (US2 AS4, SC-007)** — point `ESPN_BASE_URL` at a dead host for 60 s:
   state keeps serving, `staleness.degraded` true with a rising age, back-off
   climbs, and every pick made during the outage lands within one cycle of
   recovery.
8. **Correction (US2 AS5, FR-012)** — feed an observation with a pick removed:
   state reconciles, one `draft_revised` is emitted, no duplicate or phantom
   picks, and no prior event is retracted.
9. **Batched observation (FR-020a, SC-003)** — feed an observation revealing five
   picks that jump the owner from 6-away to on-the-clock: every implied event
   fires in order, `on_deck` is **not** skipped, `picks_until` reports the real
   value (possibly 0), and all share one `observed_at`.
10. **Event replay (SC-010)** — the full captured draft through the pure reducer,
    DO-free: one `pick_made` per pick in order, paired `on_deck`/`on_the_clock`
    per owner turn, exactly one terminal `draft_complete`.
11. **Multi-client (FR-017)** — two tabs receive identical frames with identical
    `seq`; killing one leaves the other unaffected.
12. **Isolation (FR-018)** — a second account requesting the same league's draft
    routes gets 404 on every one, including the WebSocket upgrade.
13. **Unsupported format (US3 AS4, FR-006)** — an auction league reports
    `status: "unsupported"`, opens no session, arms no alarm, and stays fully
    usable elsewhere.
14. **Archive (FR-013, SC-010a)** — on completion the D1 archive holds every pick,
    the keepers, the order, the teams and the owner's team; it survives a
    subsequent league re-sync **and** disconnecting the league.
15. **No secrets (FR-024a)** — dump the DO storage blob and every D1 draft row:
    neither contains `espn_s2` or `SWID` values.
16. **Zero writes to ESPN (SC-008)** — `disableNetConnect()` plus the request log
    across a full replay shows GETs only.

## Test suite

```bash
npm test
```

Two projects run under one command: the existing suite, plus `tests/draft/**`
with `isolatedStorage: false` (WebSockets in DOs are unsupported with per-file
isolation — research §6).

**Before writing the FR-017 eviction test**, bump
`@cloudflare/vitest-pool-workers` — `evictDurableObject` is absent from the
installed 0.8.71.

## Draft-day notes (feeds 009's runbook)

- **Deploy the DO migration well before draft day.** Migrations cannot be
  gradually deployed, and deploying a new Worker version restarts every Durable
  Object and disconnects every WebSocket. Clients auto-reconnect and polling
  resumes on its own, but "no deploys during a draft" belongs in the runbook.
- Alarm timing is best-effort — Cloudflare documents delays of up to a minute
  during failover. The 3 s tier is a target, not a guarantee.
- A live session bills ~1,382 GB-s for a 3-hour draft. A session stuck `armed`
  would burn ~11,000 GB-s/day, which is what the absolute armed deadline exists
  to prevent — verify it fires on a postponed draft.
