# Phase 0 Research: Deployment Ops

**Feature**: 009-deployment-ops | **Date**: 2026-08-08

Six questions, each researched and then adversarially challenged. **All six
first-pass conclusions were wrong in at least one load-bearing way**, and the
corrections are recorded here rather than quietly applied — several of them
change what gets built.

> **A note on the database identifier.** Nothing in this feature's documents may
> quote the D1 database *id*. `specs/` is a swept root and the privacy sweep
> cannot distinguish a database id from a SWID — both are bare UUIDs (§1.4). The
> database is named `draft-genie` and that is how every procedure here refers to
> it. This is the first consequence of a finding, not a stylistic choice.

---

## §1 — Continuous integration (FR-009…FR-013)

**Decision**: one workflow, one job, **zero secrets**.

```yaml
name: ci
on:
  push:                          # no branch filter — FR-009 says "every push"
  pull_request:                  # NEVER pull_request_target
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: git diff --exit-code web/public/draft-tap.user.js
```

**Rationale**. FR-013 is already satisfied by the codebase and was *verified*,
not assumed: the full suite passes with `.dev.vars` deleted, `HOME` pointed at an
empty directory (no `~/.wrangler` OAuth token) and no `CLOUDFLARE_*` variables.
`SESSION_SECRET` and `CREDENTIAL_KEY` are test-only base64 literals in the vitest
configs, and `@cloudflare/vitest-pool-workers` runs entirely in local
Miniflare/workerd — the `database_id` in `wrangler.jsonc` is never dialled.
Migrations are read from disk by `readD1Migrations()` and applied per test file,
so no `wrangler d1 migrations apply` is needed.

Because the job needs no secrets, `on: pull_request` is both sufficient and
correct: GitHub withholds every secret from fork-triggered `pull_request` runs.
`pull_request_target` would hand full secrets to a run whose checkout the
contributor controls, and there is no reason to reach for it.

### Corrections applied after challenge

**1.1 — `concurrency: cancel-in-progress` was removed.** A cancelled run is a
commit with no pass/fail, which is exactly what **SC-004** forbids. The first
draft included it out of habit.

**1.2 — the trigger lost its branch filter.** `push: branches: [main]` would
leave feature-branch pushes unchecked while FR-009 says "every push" and SC-004
says 100%. The cost is a duplicate run on same-repo PR branches — about 30 s of
free public-repo minutes.

**1.3 — `npm test` FAILS on a pristine clone, and this is a real bug, not a CI
quirk.** `wrangler.jsonc` declares `assets.directory: "web/dist"`, `web/dist` is
gitignored, and the pool validates the directory while loading the config.
Verified: `git archive HEAD | tar -x` into a scratch directory then `npm test`
exits 1 with *"The directory specified by the `assets.directory` field … does not
exist"*. **Fix this at the source** (a `pretest` step or `mkdir -p web/dist`), so
a new contributor is not the one who discovers it. `npm run build` stays in the
workflow for its own sake — it exercises the vite build `npm run deploy` depends
on — but it is not the remedy.

**1.4 — the privacy sweep must be fixed BEFORE it becomes a merge gate.** Two
defects, both one-liners in `scripts/privacy-sweep.ts`:

- **It violates FR-011 itself.** The GUID branch pushes
  `non-placeholder GUID ${g.slice(0, 8)}…` — 32 bits of a real SWID into what is
  about to become a *public* CI log. The member-name branch already does the
  right thing and reports a length only. Make the GUID branch match.
- **The `espn_s2` check misses the shapes a real leak takes.** The regex
  requires an *unquoted* key followed by a quoted value, so JSON
  `"espn_s2": "AEB…"` — the shape every captured ESPN fixture uses — and a raw
  cookie string both pass.

**And the sweep will block 009's own deliverables** unless a decision is taken
now. `specs` is a swept root; `isFabricated()` admits only the fixed test SWID,
the derived `00000000-0000-4000-8000-…` pattern, and "every hex group a repeated
character". A real D1 database id written into a runbook under `specs/` fails the
sweep. **Decision: refer to the database by name (`draft-genie`) and never by
id, anywhere under a swept root**, and add a test asserting the runbook stays
clean. `wrangler.jsonc` keeps its id and is unaffected — repo root is not swept.

**1.5 — `npm run typecheck` misses a project.** It runs the root and tap
configs; `web/tsconfig.json` is a third. Verified `tsc -p web/tsconfig.json
--noEmit` exits 0 today, so folding it into the script is free and fixes local
checking as well as CI. FR-009 says *all* type-check projects.

**1.6 — Node is pinned inline to `22`**, the verified dependency floor (wrangler
4.118.0 requires `>=22`). One pin, not two: an untested `.nvmrc` plus an
unenforced `engines` field is two places to drift.

**Alternatives rejected**: parallel jobs (the suite is 30 s; four jobs would each
re-pay `npm ci` and produce four checks to wire into branch protection);
`pull_request_target` (hands secrets to contributor-controlled code); a prettier
gate (322 files currently fail — that is a separate cleanup, not a gate).

**Also needed, outside the workflow**: branch protection on `main` requiring the
single `check` job, "require branches up to date" (US2 AS-4), and "do not allow
bypassing" — with a **documented draft-day break-glass** in the runbook, because
Principle V means the operator must be able to land a fix mid-draft.

---

## §2 — Alert delivery (FR-001…FR-008)

**Decision**: reuse the existing `EMAIL` send_email binding through a **new,
separate alert module** — not a method on `EmailSender`. The destination comes
from an **`ALERT_TO` secret**, never from `wrangler.jsonc`.

**Rationale**. The binding, the verified domain and the provider factory already
exist; adding a second delivery provider for an audience of one contradicts
Principle VIII. `ALERT_TO` must be a secret rather than a `destination_address`
in the config because **`wrangler.jsonc` is committed to a public repo** and that
would publish the operator's personal address.

Alerts fire from the **cron**, never from the Durable Object. The defensible
reasons are that an outbound email inside a single-threaded DO blocks that
session during a live draft, the alarm has no D1 view of league-wide state, and
per-session alerting fans out N messages for one condition. (The first draft
justified this as "the alarm is on the pick path", which is simply untrue.)

### Corrections applied after challenge

**2.1 — SC-002 is NOT achievable on the current cron, and the arithmetic is not
close.** The hidden-tab lapse threshold is `LAPSE_HIDDEN_MS = 150_000` and the
cron grid is `*/5 * * * *` = 300 s. Worst case is 150 + 300 = **450 s before the
scan even runs**, plus delivery — against SC-002's five minutes. Either add a
second `* * * * *` trigger that runs *only* the live-draft lapse scan, or relax
SC-002. **This is a decision for `/speckit-clarify`, not for the plan to take
silently.** The plan carries it as an open question.

**2.2 — the FR-003 rule must be level-triggered, not edge-triggered.** "Was live
on the previous tick and lapsed now" can never fire for a tap that arms and dies
inside one 300 s window. Evaluate the condition as it stands now, with dedupe
state doing the debouncing.

**2.3 — do not call `latestLeagueHeartbeat()` from the alerter.** It carries a
per-viewer entitlement filter (`team_match_source = 'auto' OR account_id = …`)
that collapses to same-account-only for a `manual` connection. An operator
alerter must query `draft_sessions` for the league directly, unfiltered. Its real
merit — surviving relayer handover — is worth keeping; the reasoning in the first
draft was wrong.

**2.4 — "the server stopped" must be a DIVERGENCE, not wall-clock staleness.**
005 ruled out pick silence as evidence (~1 s under autodraft, 90 s+ between human
picks). Compare what the ingest has accepted against what the session has
consumed: unconsumed batches beyond the session's cursor *while the heartbeat is
fresh* means ingest works and the session is not pumping. That is a true
server-side signal with no false alarm on a slow round.

**2.5 — the outbound screen must also check for URLs and cover the subject.**
`src/api/tap.ts` already rejects both GUIDs and `https?://` on the wire; the
alert path should reuse that shape and assert it immediately before
`EMAIL.send()`, with a contract test rejecting a body carrying a UUID, an `@`, or
a URL.

**2.6 — `runAlertScan` must NOT be wrapped in `stage()`.** `stage()` swallows
every throw. The alerter is the one failure that must reach the platform, so let
it propagate to `scheduled()` and land in Cron Trigger Past Events.

**Open question for clarify**: FR-008 requires an alert to name *which* league,
and the scan is global across accounts. The constitution's isolation rule has no
operator exemption. Either digest the league identifier, scope alerts to leagues
the operator is entitled to see, or **record an explicit operator exemption**.
`espn_league_id` is judged safe on its merits — it is a league identifier, not a
member identifier — but that is a judgement, not a verified fact.

**Not safe in an alert body**, and this is settled: `connection_id` (a UUID that
maps 1:1 to an account+league, and under fan-out belongs to other accounts), and
`league_snapshots.league_name` (ESPN-side user-authored text that can carry a
person's name).

---

## §3 — Operational state and retention (FR-001, FR-002, FR-004, FR-006, FR-007)

**Decision**: **one small D1 table of per-condition state.** No per-tick history
table, no Logpush.

Shape — modelled on `draft_sessions.consecutive_errors`, which is already exactly
this for one league:

| Column | Purpose |
|---|---|
| `key` | condition + scope, e.g. `stage:archive` or `draft_lapsed:<league>:<season>` |
| `last_ok_at`, `last_failed_at` | freshness; the investigative fact |
| `consecutive` | FR-002 — "repeatedly rather than once" |
| `last_error_code` | a **bounded code**, never free text |
| `last_notified_at`, `notify_count` | FR-006 — bounded repetition |
| `resolved_at` | so a cleared condition can notify again later |

**Rationale**. What logs genuinely cannot do is carry a **counter across ticks**.
`stage()` catches every throw, calls `logError` and returns void, so FR-002 and
FR-006 have no state to stand on. That is the real case for a table.

### Corrections applied after challenge

**3.1 — the original argument was false and has been withdrawn.** The first
draft claimed logs cannot see a missing cron because a healthy idle tick emits no
custom log lines. Only half of that is true: Workers Logs still records one
invocation log per cron fire, and Cron Events keeps the last 100 invocations. So
**missing ticks are visible for 3–7 days**. The table is justified by FR-002/006,
not by FR-004 retention.

**3.2 — the per-tick history table was dropped.** ~288 rows/day plus a 30-day
prune plus a new FR-021 exposure, to satisfy a requirement that Workers Logs
already covers for 3–7 days. FR-007's bar is "long enough to notice and
investigate"; durable current-state answers *when did this last succeed*, which
is the investigative fact. **Recorded as an assumption clarify may overturn** —
if per-run history is wanted, the case must first show that 3–7 days fails.

**3.3 — never store a free-text error string.** `redact()` strips braced SWIDs,
`espn_s2` assignments and long blobs — **not bare UUIDs**, and the privacy sweep
cannot inspect D1 rows at all. Store a stage name plus a bounded error code.

**3.4 — fix `scheduled()` to await.** `src/index.ts` calls
`ctx.waitUntil(runScheduledMaintenance(...))` without awaiting, so a failing tick
is reported to the platform as success and the ops write can be stranded. Fixing
this is cheaper than any table and makes the free platform signal truthful.

**3.5 — one gap is accepted in writing.** "A stage produced no output" is covered
by state. "**The cron itself stopped**" is covered by no in-Worker detector,
because the detector and the notifier both run on the dead cron. Closing it needs
an external heartbeat, which is more machinery than one operator warrants. The
runbook names Cron Events as the manual check instead.

**Also corrected**: the claim that no cron outcomes are recorded anywhere is too
strong. `recordSyncSuccess`/`recordSyncFailure` write
`league_connections.last_sync_at` / `last_sync_status` from two of the five
stages. What is genuinely absent is a **per-stage** record.

---

## §4 — Backup and recovery (FR-018…FR-021)

**Decision**: a scratch-database drill, because **D1 Time Travel cannot restore
into a scratch database** — it only ever overwrites in place.

1. Export an **FK-closed, PII-free subset** from production (read-only):
   `--table pro_teams --table players --table projection_sets
   --table player_projections --table signal_entries`.
2. `wrangler d1 create draft-genie-drill`, load the export.
3. `time-travel info` → bookmark; destroy rows **in the drill database only**;
   `time-travel restore` to the bookmark; verify `player_projections` is back.
4. Record the date; delete the drill database.

### Corrections applied after challenge

**4.1 — the first draft's table list would have failed on foreign keys, and
would have exported another user's data.** `draft_archives` and `tap_batches`
both reference `accounts(id)`, which was not in the list. The chosen five tables
have no foreign keys outside the set and carry **no account ids, no league ids
and no league names** — which matters because this is a public repo and the
operator is not the only user.

**4.2 — "production untouched" is wrong.** A running export *blocks other
database requests*. The honest claim is **"production is never written and never
restored"**, and the drill must run outside any pre-draft window.

**4.3 — FR-020 must be stated as two bounds**: earliest restorable point =
`max(database creation, now − retention)`. Retention is 30 days on Workers Paid
and 7 on Free; **which tier applies here is unverified** and must be recorded.
An out-of-window request returns a bare `internal error [code: 7500]`, not a
clear rejection — worth writing down so it is not mistaken for a fault.

**4.4 — `rebuild()` is a mandatory post-restore step**, alongside
`wrangler d1 migrations apply`. The Durable Object cursor is not restored with
D1, and a surviving cursor makes a restored tap log invisible.

**4.5 — do not rewrite 002's ratified clarification.** FR-021 removes the
prior-season DELETE from `pruneSets()`, but editing the 2026-08-02 clarification
answer would falsify the record of what was decided. Add a **dated superseding
note** to 002's FR-018, correct the overstatement in `0008_draft.sql`'s comment,
and record the decision in ROADMAP.md.

**4.6 — the FR-021 sweep was too narrow.** Other destructive rules exist and each
must be recorded as intended or corrected: `deleteConnection` cascading
`preferred_players`, `deleteAccount` cascading the whole irreplaceable set, the
`signal_entries` per-kind delete, and the already-executed `DROP TABLE
tier_entries`.

**4.7 — removing the only size bound needs a replacement signal.** If prior
seasons are retained (~16 MB/season, measured), add a `database_size` threshold
check to the cron. Discovering the ceiling on draft day is the failure mode this
feature exists to prevent.

**4.8 — the annual export idea was dropped.** The genuinely irreplaceable data is
65 KB. An export that is never restored does not meet FR-018's own bar, and
storing it raises a question about where a file containing another account's
league identifiers lives.

---

## §5 — Secret rotation (FR-022)

**Decision**: rotate `CREDENTIAL_KEY` by **purge-then-swap**, not dual-key
re-encryption. The ciphertext carries no key id or version, so old and new are
indistinguishable — but every call site already handles *"this account has no
credentials"* and none handles *"undecryptable credentials"*. Move the fleet
through the state that is implemented and tested.

**Order is load-bearing**:

1. Advance notice out of band: *do not open Draft Genie until I say so*.
2. `DELETE FROM espn_credentials` — the entire data migration. The only FK is
   child-to-parent, so nothing else is touched.
3. `wrangler secret put CREDENTIAL_KEY` (32 bytes, base64).
4. Wait a few minutes for propagation, **then** tell owners to re-paste.
5. Verify via `league_connections.last_sync_status = 'ok'` with a `last_sync_at`
   after the rotation.

### Corrections applied after challenge

**5.1 — the notification was in the wrong place.** Telling owners first invites a
paste that lands between the DELETE and the new key going live — encrypted under
the *old* key, producing exactly the stranded `status='working'` row the purge
exists to prevent. Split the message in two, and allow for propagation being
eventually consistent.

**5.2 — the verification step proved nothing.** `upsertCredentials` writes
`status='working'` at insert time, so selecting from `espn_credentials` shows
only that a row exists. Only a successful league sync proves a decrypt under the
new key plus an authenticated ESPN read.

**5.3 — a fabricated citation was removed.** The first draft cited "Constitution
V / FR-024: never rotate inside a pre-draft window". 009's FR-024 says no such
thing — it forbids adding work to the live draft request path. Cite Constitution
V alone, or add a real requirement.

**5.4 — a cross-runbook hazard was missed.** After a rotation, **any restore to a
point before it leaves ciphertext under a key that no longer exists** and must be
followed by a purge and re-paste. This belongs in the recovery procedure too —
the person restoring months later will not be reading the rotation runbook.

**5.5 — the app will not prompt anyone.** Both credential banners key on
`failing`, not on absent, so after the purge no owner is nagged; their leagues
simply show "Last refresh failed". The out-of-band message is load-bearing, not a
courtesy.

**5.6 — `SESSION_SECRET`'s rationale was wrong.** `wrangler secret put` is a
deployment: it restarts every Durable Object and terminates every WebSocket. So
the timing rule for **both** secrets is Constitution V — never during a live
draft — with sign-out being an extra consequence of `SESSION_SECRET` specifically.

Token hashes (`tap_pairings.token_hash` and friends) need no rotation procedure:
they are unkeyed digests. "Rotating" one means revoking and re-enabling.

---

## §6 — Signal inventory (FR-003, FR-004, FR-008)

**The spec's assumption — "threshold on state the system already records" — is
half true, and the false half is named in the spec's own Dependencies list.**

### Ready to use

| Need | Existing state |
|---|---|
| Projection freshness (FR-004) | `getServingSet(season).fetched_at` + `isStale()` |
| Signal freshness (FR-004) | `MAX(signal_entries.computed_at)` |
| League sync (FR-004) | `league_connections.last_sync_at` / `last_sync_status` |
| Scope for an alert (FR-008) | `espn_league_id` + `season` |

### Corrections applied after challenge

**6.1 — a lapsed heartbeat means "the tap process died", NOT "picks stopped".**
`recordRelayActivity()` refreshes `last_heartbeat_at` on every accepted batch and
can only ever *add* liveness. **So the exact failure this spec cites twice — the
2026-08-06/07 freeze, picks not appearing while the tap was perfectly healthy —
produces no alert under a heartbeat-only design.** SC-002 as literally worded
needs a second predicate: during a live draft, `MAX(tap_batches.received_at)` for
the league not advancing for N minutes, with N ratified against 005's measured
90 s+ human-pick gaps.

**6.2 — `isLiveDraft()` is the wrong gate.** It thresholds on
`status IN ('armed','live','not_receiving','degraded')`. Verified: `not_receiving`
and `degraded` are **never written** — they appear only as derived strings and in
IN-clauses — and `idle`, which the list excludes, is the current production state
of both tap-attached sessions. Gate instead on facts that are actually written:
`completed_at IS NULL AND armed_at IS NOT NULL AND last_heartbeat_at IS NOT NULL`.

**6.3 — the archive signal was blind to the failure that motivated it.**
`sessionsAwaitingArchive()` requires `completed_at IS NOT NULL`, which is set only
when `totalPicks > 0 && picks.length >= totalPicks` — so a draft with
`totalPicks = 0` (the empty draft order this spec reports in *every* production
draft) never completes, never enters the queue, and reads healthy on zero rows.
It can also go **permanently red**: `no_picks` and `connection_gone` leave
`completed_at` set and `archived_at` NULL forever. Replace with a **disagreement
check** — for a league whose draft date has passed, assert a `draft_archives` row
exists — and record the archive attempt's outcome so silence is distinguishable
from a deliberate skip.

**6.4 — the server-side stall signal should not touch draft-day code.**
Reviving `saveCursor()` (verified: zero callers, `feed_received_at` NULL in
production after 408 batches) would put a D1 write inside the Durable Object's
`blockConcurrencyWhile` gate, which the draft room's snapshot reads contend for.
The cron already reaches every live session and `snapshot()` already returns
`revision`. **Poll the revision from the cron and store it in the ops table** —
same fact, zero new draft-day writes.

**6.5 — signals freshness must alert independently of projections.**
`computeSignals` runs only when projections refreshed or the table is empty, so a
signals failure after a successful ingest is never retried and never co-fires.
Dedupe by `(condition, scope)`, never by presumed common cause.

### Do not use

`draft_sessions.status` as a health threshold (§6.2). `consecutive_errors`
(written by nothing) and `last_error` (written by one path and never cleared —
see the note below). Row counts on any table: `signal_entries` is fixed-size by its primary
key, `draft_archives` grows once per league per season, `projection_sets` is
pruned. **Freshness timestamps are the shape that works.**

> Verified aside: `resetSession()` does not clear `last_error`, so a healthy idle
> production session still carries `armed_deadline` from 2026-08-07. Harmless
> today, and precisely the sort of stale field an alerter must not read.

---

## Summary of what changed because of the challenge round

| § | The first answer | Why it was wrong |
|---|---|---|
| 1 | cancel in-progress runs | a cancelled run has no verdict — breaks SC-004 |
| 1 | make the sweep a gate | the sweep leaks 32 bits of a SWID into a public log |
| 2 | heartbeat covers SC-002 | detects a dead tap, not stopped picks — misses the real incident |
| 2 | 5-minute cron is fine | 150 s + 300 s = 7.5 min against a 5 min target |
| 3 | per-tick history table | logs already cover 3–7 days; the counter is the real need |
| 4 | export these five tables | foreign keys unsatisfied, and it exported another user's data |
| 5 | notify owners, then purge | invites a paste encrypted under the dying key |
| 6 | gate on `isLiveDraft()` | gates on statuses never written, excludes the live one |

**Every one of these would have shipped.** They were found by an adversarial pass
whose only instruction was to disprove the conclusion — which is the same lesson
this feature is about, applied to its own planning.
