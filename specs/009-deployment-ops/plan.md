# Implementation Plan: Deployment Ops

**Branch**: `019-009-spec-refresh` (spec dir `009-deployment-ops`) | **Date**: 2026-08-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-deployment-ops/spec.md`

## Summary

Close the gap between *something is wrong* and *someone knows*. Nine features
have shipped without a single loud failure; every defect this project has had was
found by a person happening to look, and the two worst were found by the owner
**during a live draft**.

The approach turns on one decision that keeps the rest small: **derive alerts
from state the system already writes, and add exactly one table — a counter.**
Freshness timestamps, heartbeats and sync outcomes are already recorded. What is
missing is not data but *memory between ticks*: `stage()` catches every throw and
returns void, so "has this failed repeatedly" (FR-002) and "have I already said
so" (FR-006) have nowhere to live. One small keyed state table supplies both.

Research changed the shape of this feature in four ways that matter, each
recorded in [research.md](./research.md):

1. **A lapsed heartbeat does not mean picks stopped.** `recordRelayActivity`
   refreshes the heartbeat on every accepted batch, so the 2026-08-06/07 freeze —
   healthy tap, no picks reaching the room — produces **no alert** under the
   obvious design. FR-003 needs three predicates, not one (§6.1).
2. **SC-002 is unreachable on the current cron.** 150 s lapse + 300 s grid = 7.5
   minutes against a five-minute target (§2.1). Open question, below.
3. **The privacy sweep must be fixed before it becomes a gate** — it prints 32
   bits of a real SWID into what would become a public CI log, and it would
   block this feature's own runbook (§1.4).
4. **Time Travel cannot restore into a scratch database.** The drill is
   export → new database → restore *there* (§4).

**One new table. One new workflow file. No new dependency. No change to the
draft-day request path.**

## Technical Context

**Language/Version**: TypeScript 5.7, ES2022. Node 22 floor (wrangler).

**Primary Dependencies**: none added. Changes land in `src/sync/predraft.ts`
(stage outcomes), `src/index.ts` (await the scheduled run), a new
`src/ops/` module (conditions, alert rendering), `src/email/` (reuse the
binding), `scripts/privacy-sweep.ts` (two defect fixes), `package.json`
(typecheck project, fresh-clone fix), plus `.github/workflows/ci.yml` and
`docs/runbook.md`.

**Storage**: one new D1 table of per-condition state. No change to any existing
table's shape. Migration `0014`.

**Testing**: vitest — `tests/unit/**` for the pure condition logic,
`tests/contract/**` for the outbound alert screen, existing projects unchanged.
The alert predicates are pure functions over rows, which is what makes them
testable without a live draft.

**Target Platform**: Cloudflare Workers, one environment, cron-driven.

**Project Type**: operational hardening across shipped features. No new product
surface, no UI.

**Performance Goals**: none new. The binding constraint is the inverse — **SC-009
requires draft-day behaviour and latency to be unchanged**, so every alert
evaluation happens on the cron and nothing is added to the draft-room or
tap-ingest path.

**Constraints**: read-only against ESPN; no recommendation rule changes; no ESPN
credential, member identifier or manager name in any alert body, CI log or
committed document; the repo is **public** and the product is **multi-user**.

**Scale/Scope**: one operator, two accounts, a handful of leagues, ~288 cron
ticks/day.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see below.*

| Principle | Assessment |
|---|---|
| **I. Spec-First** | ✅ spec written 2026-08-06, refreshed and re-verified 2026-08-08, then clarified the same day — four questions answered, one of which amended the constitution. Implementation has not started. |
| **II. Any-League** | ✅ unaffected. Alerts are scoped by `espn_league_id`; nothing is hardcoded. |
| **III. League Currency** | ✅ untouched — no scoring or projection maths in this feature. |
| **IV. Rules Are Code** | ✅ no rule, weight or threshold in the recommendation engine changes. FR-023 states it. **Alert thresholds are operational, not recommendation rules**, and are code with tests — not user settings. |
| **V. Draft Day Is Unforgiving** | ✅ **and it is the reason FR-003 got harder.** The naive heartbeat alert would have stayed silent through the exact draft-day failure that motivated this feature. The runbook adds a documented break-glass so branch protection cannot block a mid-draft fix. |
| **VI. Recommend, Never Act** | ✅ nothing here reads or writes ESPN. Every signal is internal state. |
| **VII. Explainable** | ✅ unaffected. Applied by analogy: an alert names the condition and the remedy, never a bare code (FR-015). |
| **VIII. Simplicity** | ✅ **the challenge round removed machinery twice**: a per-tick history table (logs already cover 3–7 days) and an annual export pipeline (65 KB of irreplaceable data, and an export never restored proves nothing). One table, one workflow, no Logpush, no metrics product. |

**Security & Privacy**

- **The public repo is a first-class constraint, not a footnote.** `ALERT_TO` is
  a **secret**, not a `destination_address` in `wrangler.jsonc`, because that file
  is committed. The D1 database is referred to **by name only** in every
  document, because `specs/` is swept and a database id is indistinguishable from
  a SWID.
- **FR-005 is enforced twice.** Alerts render from a closed vocabulary — numeric
  league id, season, counts, ISO timestamps — and an outbound screen asserts no
  UUID, `@` or URL immediately before send. One control is a design; two is a
  guarantee.
- **`connection_id` is forbidden in an alert body.** It is a UUID mapping 1:1 to
  an account and league, and under 011's fan-out it may belong to another
  account. Naming one names a person indirectly.
- **Stored error strings are bounded codes, never free text.** `redact()` does
  not strip bare UUIDs and the privacy sweep cannot see D1 rows.
- Multi-user isolation: alert scans are global by necessity (one operator
  watching the service). **The exemption was ratified in clarify and the
  constitution amended to 1.2.0** — narrow, covering the `espn_league_id` only.
  Every other identifier stays forbidden, and it licenses nothing in the product
  itself. It is written down rather than assumed, which is the whole point: a
  silent violation of the isolation rule is exactly the kind of thing this
  project has found by accident before.

**Technical Constraints**: hosting unchanged, one platform, one environment
retained. No second browser artifact.

**Result: PASS, no violations.** Complexity Tracking is empty.

### Resolved in `/speckit-clarify`, 2026-08-08

1. **SC-002 versus the cron grid** → **a second `* * * * *` trigger**, running
   only the live-draft check and short-circuiting when no draft is armed. SC-002
   stands at five minutes. FR-003c.
2. **The operator exemption for FR-008** → **ratified**, and the constitution was
   amended (1.1.0 → **1.2.0**). Narrow: the league identifier only. FR-008a/b.
3. **The stall window** → **5 minutes** of no picks during a live draft. FR-003a/b.
   This is the predicate that catches the 2026-08-06/07 freeze; a heartbeat-only
   design never sees it.
4. **A single environment** → **ratified**, no longer an assumption. CI before
   merge buys most of what staging would, and two environments that drift are
   themselves a silent-failure mode.

### Still deferred — decide during implementation

**Per-run history (FR-007).** The plan keeps current-state only, on the grounds
that Workers Logs covers 3–7 days. **Which is unverified — this account's Workers
plan is not established**, and it is 3 days on Free versus 7 on Paid. Establish
the tier first; only if 3 days proves insufficient does a history table earn its
place. Left open deliberately: it is reversible, and adding a table nobody needs
is the machinery this project keeps having to remove.

## Project Structure

### Documentation (this feature)

```text
specs/009-deployment-ops/
├── plan.md              # This file
├── research.md          # Phase 0 — 6 sections, each with its challenge corrections
├── data-model.md        # Phase 1 — one new table; what every other signal reads
├── quickstart.md        # Phase 1 — how to prove each story, including a failure drill
├── contracts/
│   ├── alerts.md        # what may be said, what may never be said, when
│   └── checks.md        # what CI runs, what blocks a merge, the break-glass
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks output — NOT created here
```

### Source Code (repository root)

```text
.github/workflows/ci.yml     # (new) one job, zero secrets
docs/runbook.md              # (new) draft-day procedures, recovery, rotation
migrations/0014_ops.sql      # (new) per-condition state
src/ops/conditions.ts        # (new) pure predicates: is this condition true now?
src/ops/alert.ts             # (new) render + outbound screen + send
src/ops/state.ts             # (new) read/write the condition table
src/sync/predraft.ts         # stage() returns an outcome; alert scan runs last
src/index.ts                 # await the scheduled run so failures are truthful
scripts/privacy-sweep.ts     # fix the GUID output leak and the espn_s2 regex
package.json                 # third typecheck project; fresh-clone test fix
tests/unit/ops-conditions.test.ts    # predicates, including the ones that must NOT fire
tests/contract/ops-alert.test.ts     # the outbound screen, adversarially
```

**Structure Decision**: a new `src/ops/` module, because there is no existing
home for "facts about our own health" — `src/draft/liveness.ts` is about one
session's tap, and `src/sync/` is about ESPN. Everything else lands in the module
that already owns the behaviour. The predicates are deliberately separated from
the sending so they can be tested without an email binding.

## Phase Sequencing

| Phase | Delivers | Story |
|---|---|---|
| **0 — Make the gate safe** | privacy-sweep defect fixes; fresh-clone `npm test`; third typecheck project | prerequisite for US2 |
| **1 — CI** | one workflow, branch protection, break-glass documented | US2 |
| **2 — Ops state** | migration `0014`; `stage()` returns outcomes; `scheduled()` awaits | foundation for US1 |
| **3 — Noticing** | conditions, alert rendering, outbound screen, send | US1 🎯 |
| **4 — Runbook** | `docs/runbook.md`, including the corrected platform limits | US3 |
| **5 — Recovery** | the drill, executed once and dated; FR-021 reconciliation | US4 |

**Phase 0 is not optional and must come first.** Turning on a merge gate whose
GUID branch prints part of a real SWID into a public log would ship a privacy
regression in the name of preventing one.

**US1 is the MVP** and Phase 3 is the substantial work. Phases 4 and 5 are
documentation and a one-time exercise; they are the cheapest and could be pulled
forward if a draft is imminent, since a runbook helps on a day when code changes
cannot.

**Suggested order if time is short**: 0, 1, then 4. CI and a runbook are most of
the value at a fraction of the work; alerting is the part that needs care,
because an alert that cries wolf is worse than none.

## Post-Design Constitution Re-check

| Risk surfaced by the design | Verdict |
|---|---|
| Does an alert body leak anything? | **No, and it is enforced twice** — a closed rendering vocabulary plus an outbound screen asserted before send, with an adversarial contract test. `connection_id` and `league_name` are forbidden by name. |
| Does the ops table become a new FR-021 liability? | **No.** It stores bounded codes and timestamps keyed by condition; no user content, no free text, nothing irreplaceable. It is prunable without loss. |
| Does anything touch the draft-day path? | **No.** All evaluation is on the cron. The tempting shortcut — reviving `saveCursor()` in the session pump — was **rejected** because it lands a D1 write inside the Durable Object's exclusive concurrency gate that draft-room snapshot reads contend for (§6.4). |
| Can the alerter itself fail silently? | Partly, and it is **stated rather than hidden**: `runAlertScan` is deliberately not wrapped in `stage()` so its failure reaches Cron Trigger Past Events. But **if the cron stops entirely, nothing in-Worker can notice** — the detector runs on the dead cron. The runbook names Cron Events as the manual check (§3.5). |
| Does branch protection endanger draft day? | **Mitigated by writing it down.** Principle V requires the operator to be able to land a fix mid-draft; the runbook documents the break-glass rather than leaving it to be improvised at 9:45 PM. |
| Does the recovery drill risk production? | **Production is never written and never restored** — the honest phrasing, since an export does block other requests. Drill runs outside any pre-draft window, on an FK-closed, PII-free subset. |
| Does removing the prior-season prune risk the database ceiling? | Replaced with a signal rather than a bound: ~16 MB/season measured, plus a `database_size` threshold check on the cron (§4.7). |

**Result: PASS.** No violations, no justifications required, Complexity Tracking
remains empty.

Four questions went to clarify and were answered on 2026-08-08; one of them
amended the constitution to **1.2.0**. The single remaining open item —
per-run history for FR-007 — is named above and is deliberately left to
implementation, because it depends on a platform fact (this account's Workers
plan) that has not been established, and because the reversible default is to
build nothing.
