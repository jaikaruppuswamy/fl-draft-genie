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

## Gate 0 — closed, FAILED (2026-08-03)

Do not run this. It is recorded because the result is what shaped everything
below.

Gate 0 asked whether `mDraftDetail` reflects picks *during* a draft. It does
not: **207 samples across ~30 real picks over 17.5 minutes showed it frozen**,
and `mRoster`/`mTeam` are no better — every DRAFT transaction in a finished
draft shares one `proposedDate` equal to `completeDate`. ESPN writes the draft
to its league database **once, at completion**. No read API can see a draft in
progress (research §0).

Picks therefore arrive from `010-draft-tap`, which is built, deployed and has
fed two real drafts. This feature is developed against its committed corpus, so
**no live draft is required to build or test 005**:

- `tests/fixtures/tap/replay-full.jsonl` — 72 messages from a real 6-team,
  12-round draft relayed by the shipped tap
- `tests/fixtures/tap/oracle-live-2026.json` — the same draft as ESPN reported
  it *after* completion, produced by a different mechanism than the one under
  test, which is what makes SC-010's comparison meaningful

## Setup

```bash
npm run migrate:local && npm run dev
```

To exercise the feed without a draft, insert a batch into `tap_batches` and
assert what the session pulls — the live path and the rebuild path read the same
log through the same cursor, so this covers both.

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
6. **Feed ordering (FR-007h)** — assert the ack precedes the nudge and follows
   the `tap_batches` write: a session that is unavailable must not delay
   `accepted_through`, and a batch acked but never nudged must still arrive
   within the 5 s safety alarm. Drop the nudge deliberately and confirm no pick
   is lost — only delayed.
6a. **Liveness (FR-007c/e)** — with `vi.useFakeTimers({ toFake: ['Date'] })`:
   a 45 s heartbeat gap on a **visible** tab enters `not_receiving` within 15 s;
   the same gap on a **hidden** tab does **not**, because its timers are
   throttled to ~1/minute — only 150 s does. And a **90 s gap between picks with
   heartbeats still arriving** never does. That second half is
   the one that matters — it is the false alarm a silence-based rule would
   raise on every slow human round.
6b. **Withholding (FR-007f, SC-001c)** — `incompatible` and `version-rejected`
   withhold recommendations; `buffering` and `draft-end-unknown` do not. Assert
   both directions: a rule that only ever withholds is as wrong as one that
   never does.
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

## What implementation changed (recorded 2026-08-05)

Two deliberate deviations from [plan.md](plan.md), both kept because they are
better rather than easier:

1. **Liveness is evaluated ON READ, not by a 15 s alarm.** The plan specified an
   alarm to drive the `not_receiving` state. The shipped code computes it from
   `last_heartbeat_at` and the stored `hidden` flag whenever the status route is
   asked. That satisfies SC-001b *more* tightly — detection is immediate for
   whoever is asking rather than up to 15 s stale — and needs no extra alarm, so
   it does not keep the Durable Object resident. Every consumer, including 006,
   asks through that route.

2. **Arming reads 001's stored snapshot instead of calling ESPN.** The plan said
   the session would fetch pre-draft data on arm. 001's cron already fetches and
   stores exactly that inside the pre-draft window, and arming happens on every
   heartbeat — so re-fetching would duplicate work *and* put an ESPN request on a
   15-second path, blowing FR-008's bound for no new information.

**SC-001, measured.** The server's share of the budget is p50 **1 ms**, p95
**2 ms**, max **2 ms** across the 72-message corpus, against a 2 s p95 promise;
a full replay takes ~73 ms. The end-to-end figure is 010's production
measurement — median 0.202 s, p95 0.223 s, 72/72 under 3 s. `latency.test.ts`
guards only the part this feature controls and says so, because a synthetic
harness cannot measure a browser, the tap's batching, or the public internet.

**The oracle agrees.** Replayed against ESPN's own post-completion record, the
tap-built draft matches on all 72 picks — zero missing, zero extra, zero
mismatched.

**One correct-looking gap that is not a gap.** In the corpus, the owner's turn at
overall 23 gets no `on_the_clock`: the ledger at message 22 reveals three picks
the stream never delivered, jumping the frontier 22 → 25 and crossing that turn.
The pick had already been made, so announcing it afterwards would be false. If
you see a turn with no alert, check whether a ledger crossed it before assuming
a bug.

## Draft-day notes (feeds 009's runbook)

- **Deploy the DO migration well before draft day.** Migrations cannot be
  gradually deployed, and deploying a new Worker version restarts every Durable
  Object and disconnects every WebSocket. Clients auto-reconnect and the
  session re-pulls from the log on its own, but "no deploys during a draft" belongs in the runbook.
- Alarm timing is best-effort — Cloudflare documents delays of up to a minute
  during failover. That no longer sits on the pick path: picks arrive by nudge,
  and the alarm is only the backstop that enforces SC-001's 10 s ceiling.
- **The draft-room tab is the tap.** Closing it stops the feed and the session
  will report *not receiving picks* within ~60 s. That is correct behaviour, not
  a fault.
- **Force a Tampermonkey update check before draft day** and confirm the badge
  shows the expected version. A stale edge cache has been observed serving an
  old userscript after deploy.
- A live session bills ~1,382 GB-s for a 3-hour draft. A session stuck `armed`
  would burn ~11,000 GB-s/day, which is what the absolute armed deadline exists
  to prevent — verify it fires on a postponed draft.
