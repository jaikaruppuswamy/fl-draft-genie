# Feature Specification: Deployment Ops

**Feature Branch**: `009-deployment-ops`

**Created**: 2026-08-06

**Refreshed**: 2026-08-08 — facts re-verified against production and the live
configuration after two real drafts. The four user stories, the requirement set
and the ratified Out-of-Scope boundaries are unchanged; what moved is evidence
that had gone stale. Specifically: `draft_archives` now writes (US1's headline
example), the test counts are current, the 2026-08-06/07 draft failures are
recorded, and US3's "iPad cannot monitor" premise is corrected — it was a
cross-platform defect, since fixed, not a platform limitation. See FR-016a.

**Status**: Draft

**Input**: ROADMAP 009 — "Production hardening on Cloudflare: environments, secret management, scheduled jobs, logging and alerting (especially 'draft session died mid-draft'), backups, and a draft-day runbook. Much is already exercised continuously… this feature closes the remaining gaps at the end."

> **On the number.** This feature is **009**, not 011. 010-draft-tap was numbered
> after 009 and executed before 005, so a naive "next sequential" scan of
> `specs/` produces the wrong answer. Directory numbers are identifiers, not
> execution order.

## Overview

Nine features have shipped to one production Worker, and the deployment story
has held up well enough that nobody has had to think about it. This feature is
where we think about it — once, at the end, with nine features' worth of
evidence about what actually goes wrong.

**And the evidence is unambiguous. Nothing in this project has failed loudly.
Everything has failed silently, and been found by accident.**

- `draft_archives` had **written zero rows in production** since 005 shipped.
  Found weeks later, while planning a different feature. **It writes now** — two
  rows, 2026-08-06 and 2026-08-07, one per real draft — but that is the point
  rather than a retraction: nothing reported the silence, and nothing reported
  the recovery either. The archive was repaired and no system mentioned it in
  either direction.
- `pruneSets()` deletes every prior season's projection sets on every
  maintenance run — directly contradicting a decision 002 ratified in writing.
  Found by reading the code during 008's clarify.
- Two TypeScript errors have been sitting in `tap/` for weeks. Found by running
  `npm run typecheck` during 008.
- A deploy served a stale cached `index.html` twice. Found by manually
  cache-busting.
- 008's first real run produced a confident opponent-model parameter from two
  accidental id collisions, and admitted another user's draft into a public
  repo. Both found by looking closely at output that appeared fine.

**Two live drafts on 2026-08-06 and 2026-08-07 then tested every claim above,
and the evidence got worse rather than better:**

- The draft room's live-update path had **never executed in production** — it
  read a field the frames do not carry. Picks stopped appearing after the first
  few and the room froze, on desktop Chrome and on an iPad alike. It had passed
  every test, because each side of the seam was tested against its own idea of
  the other. Found mid-draft, by the owner, twice.
- Behind that one bug sat three more it had been hiding: a resynchronisation
  loop, a stuck turn countdown, and an empty draft order that silently disabled
  two recommendation rules in **every production draft to date**.
- A tap credential and a stale bundle went on serving old copy because
  `build:tap` was in no build chain — the guarding tests asserted against an
  artifact nothing regenerated, so they passed while proving nothing.

Not one of those was caught by a system. Every one was caught by a person
happening to look — and in the worst cases, by the owner looking during the one
hour a year the product is load-bearing. **So the gap this feature closes is not
incident response — it is NOTICING.**

**Principle V is the organising constraint**: "A live draft cannot be paused or
replayed." But the corollary that matters here is subtler than draft-day
heroics. A draft happens once a year per league. The failures that hurt are the
ones that started quietly in March and were still true in August.

**What is genuinely already solid**, and must not be rebuilt: the custom domain,
D1 migrations, the encrypted-credential path, the cron trigger, Cloudflare Email
Service, and Workers observability. This feature adds what is missing around
them.

**What is missing**, verified against the live configuration:

| Gap | Current state |
|---|---|
| Continuous integration | **None.** 1,132 + 182 tests and the privacy sweep run only when someone remembers, on a **public** repo |
| Alerting | **None.** Zero notification code. Failures reach `logError` and stop there |
| Log retention | Observability enabled, **no logpush** — logs are ephemeral |
| Environments | **One.** Every deploy goes straight to the domain serving real drafts |
| Runbook | **None.** README covers local dev and workflow only |
| Backup verification | Untested. D1 point-in-time recovery is assumed, never exercised |
| Secret rotation | Undefined. `CREDENTIAL_KEY` encrypts every user's ESPN cookies |

Draft Genie remains **read-only against ESPN** (Constitution VI), and nothing
here changes a recommendation rule (Principle IV).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tell me when something has quietly stopped working (Priority: P1) 🎯 MVP

A scheduled job starts failing. A draft session stops receiving picks. The
archive silently writes nothing for a month. Today all of these are invisible
until someone reads the code or the database. The owner finds out — by a
message, not by remembering to check.

**Why this priority**: it is the single failure mode this project actually has.
Five of the six defects listed in the Overview were silent, and the shortest
time-to-discovery among them was days. Everything else in this feature reduces
the *chance* of a problem; this reduces the time it goes unnoticed, which is
the number that has actually hurt.

**Independent Test**: cause a scheduled run to fail and confirm a notification
arrives naming what failed, without anyone inspecting logs or the database.

**Acceptance Scenarios**:

1. **Given** a scheduled maintenance run fails, **When** it fails repeatedly
   rather than once, **Then** the owner is notified with the failing stage
   named — a single transient failure does not notify.
2. **Given** a draft session stops receiving picks while a draft is live,
   **Then** the owner is notified, and the notification distinguishes "the tap
   stopped" from "the server stopped" — the two have different remedies.
3. **Given** a job that is supposed to write something writes nothing for an
   extended period, **Then** that silence is itself reported. The archive
   writing zero rows for a month must not look like health.
4. **Given** a notification is sent, **Then** it contains no ESPN credential, no
   member identifier and no manager name.
5. **Given** the same condition persists, **Then** the owner is not notified
   repeatedly without bound.

---

### User Story 2 - Stop me shipping something broken (Priority: P2)

Every push runs the full suite, the type checks, the linter and the privacy
sweep. A change that breaks a test, or that would put a name or a secret into a
public repository, fails before it lands rather than after.

**Why this priority**: the repository is **public** and the product is
**multi-user**. The privacy sweep is the gate that stops another person's data
reaching the internet — and today it runs only when someone remembers to run it.
It has already failed to run at the right moment once, in this project's own
history, and real member names shipped.

**Independent Test**: open a change that breaks a test and one that adds a
forbidden identifier to a fixture; confirm both are rejected automatically.

**Acceptance Scenarios**:

1. **Given** a push or a pull request, **Then** the full test suite, both type
   check projects, the linter and the privacy sweep all run automatically.
2. **Given** any of those fail, **Then** the failure is visible on the change
   itself, before merge.
3. **Given** the privacy sweep finds a name, a credential or an unrecognised
   identifier, **Then** the change is blocked, and the finding is reported
   without reproducing the offending value.
4. **Given** the checks pass, **Then** the result is attributable to a specific
   commit — a green tick on stale results is worse than none.

---

### User Story 3 - Tell me what to do, on the day, without reading code (Priority: P3)

It is ten minutes before the draft. Something is wrong. The owner opens one
document that says what to check, in order, and what each symptom means.

**Why this priority**: the draft is the one hour a year where the product is
load-bearing and there is no time to reason from first principles. This project
already knows its failure modes in unusual detail — Gate 0, the tap's
limitations, reachability versus withholding, the stale-snapshot case — and that
knowledge currently lives in specs, comments and one person's memory.

**Independent Test**: hand the runbook to someone who has not read the code and
have them diagnose a withheld recommendation and a dead tap from the symptoms
alone.

**Acceptance Scenarios**:

1. **Given** the draft room shows no recommendations, **Then** the runbook
   distinguishes the causes and gives the remedy for each.
2. **Given** the tap is not delivering, **Then** the runbook says how to tell
   that from a browser problem, and what to do — including that the draft-room
   tab **is** the tap.
3. **Given** the draft is about to start, **Then** the runbook lists what to
   verify beforehand and by when.
4. **Given** something fails that the runbook does not cover, **Then** it says
   what to capture so the failure can be understood afterwards.
5. **Given** a documented limitation, **Then** the runbook states it plainly
   rather than leaving it to be discovered on the day — and states it for the
   RIGHT half of the product. **Relaying** needs a desktop browser with a
   userscript manager; **watching** is an ordinary web page and works anywhere,
   including an iPad.
6. **Given** a symptom that resembles a platform limitation, **Then** the
   runbook does not assert one without evidence. This scenario previously read
   "desktop Chrome only; no live monitoring from an iPad", which the drafts of
   2026-08-06/07 disproved: the iPad froze because the room's live-update path
   read a field the frames do not carry, and desktop Chrome froze identically.
   A runbook that had shipped that sentence would have told the owner to
   abandon a device that works, and hidden the real defect behind a rule.

---

### User Story 4 - Let me get the data back (Priority: P4)

Something is deleted, corrupted, or quietly pruned. The owner can restore it,
and knows this because it has been tried — not because a provider's
documentation says so.

**Why this priority**: this project has already lost data to a mechanism nobody
intended. `pruneSets()` destroys every prior season's projections on a schedule,
contradicting a ratified decision, and the only reason it has not hurt is that
008 works around it. An untested restore is a belief, not a capability — but it
ranks last because the data at risk is reconstructible: projections can be
re-fetched, and drafts are archived as fixtures.

**Independent Test**: restore the database to a point in time in a scratch
location and confirm the expected rows are present.

**Acceptance Scenarios**:

1. **Given** a need to recover, **Then** the recovery procedure is written down
   and has been executed at least once against real data.
2. **Given** the recovery is exercised, **Then** it does not disturb production.
3. **Given** a retention rule destroys data, **Then** it is either intentional
   and recorded, or corrected — no rule survives because nobody noticed it.
4. **Given** the retention window of the recovery mechanism, **Then** it is
   stated, so an expectation of "we can always go back" is not silently wrong.

---

### Edge Cases

- **The alert channel is the thing that is broken.** Sign-in email and alerting
  share a provider; if it is down, the alert about it cannot arrive.
- **Draft day generates many alerts at once.** A failing draft must not produce
  a message per pick.
- **A failure fires while the owner is asleep.** Drafts run in the evening;
  scheduled jobs run continuously.
- **Nothing is wrong and nothing is happening.** Silence must be distinguishable
  from health — no drafts in March is normal, no archive rows in September is
  not.
- **CI runs on a fork or an outside pull request.** It must not require secrets
  it cannot have, and must not expose any it does have.
- **The privacy sweep fails in CI.** Its output must not reproduce the value it
  objected to, or the log becomes the leak.
- **A deploy succeeds and serves stale assets.** Already observed twice.
- **Restoring to a point in time undoes a migration**, leaving schema and data
  disagreeing.
- **A secret must be rotated while user data depends on it.** `CREDENTIAL_KEY`
  encrypts every stored ESPN cookie pair; rotating it naively makes every
  connection unreadable.
- **Two managers in one league.** Anything operational that reports "the draft"
  must say whose.

## Requirements *(mandatory)*

### Functional Requirements

**Noticing (US1)**

- **FR-001**: The system MUST notify the owner when a scheduled maintenance run
  fails repeatedly, naming the stage that failed.
- **FR-002**: The system MUST NOT notify on a single transient failure — the
  cron runs every five minutes and a per-failure alert would be noise.
- **FR-003**: The system MUST notify when a live draft session stops receiving
  picks, and MUST distinguish a tap-side cause from a server-side one.
- **FR-004**: The system MUST detect and report **absence of expected activity**
  — a job that should have produced output and produced none — not only errors.
- **FR-005**: Every notification MUST be free of ESPN credentials, member
  identifiers and manager names.
- **FR-006**: Repeated notification for one persisting condition MUST be bounded.
- **FR-007**: Operational signals MUST be retrievable after the fact, for at
  least as long as it takes to notice a problem and investigate it.
- **FR-008**: Where a notification concerns one league or one account, it MUST
  identify which — the service is multi-user.

**Not shipping a break (US2)**

- **FR-009**: Every push and pull request MUST automatically run the full test
  suite, all type-check projects, the linter and the privacy sweep.
- **FR-010**: A failing check MUST block the change visibly, before merge.
- **FR-011**: The privacy sweep MUST run in CI and MUST NOT reproduce an
  offending value in its output.
- **FR-012**: Check results MUST be attributable to a specific commit.
- **FR-013**: CI MUST run without production credentials, and MUST NOT expose
  any secret it is given to untrusted contributions.

**Draft day (US3)**

- **FR-014**: A runbook MUST exist covering, at minimum: pre-draft verification
  and its deadline; no recommendations appearing; the tap not delivering;
  reachability failure; and what to capture when something is not covered.
- **FR-015**: The runbook MUST distinguish failures by remedy, not by cause —
  the owner needs to know what to do, not what broke.
- **FR-016**: The runbook MUST state the product's documented limitations, and
  MUST scope each one to the half of the product it actually constrains:
  **relaying** requires a desktop browser with a userscript manager;
  **watching** is an ordinary web page with no such requirement.
- **FR-016a**: The runbook MUST NOT record a limitation that has not been
  demonstrated. A symptom reproduced on one device is evidence about the
  product, not about the device — the 2026-08-06/07 freeze presented as an iPad
  limitation and was a defect on every platform.
- **FR-017**: The runbook MUST be usable by someone who has not read the source.

**Recovery (US4)**

- **FR-018**: The recovery procedure MUST be written down and MUST have been
  executed at least once against real data.
- **FR-019**: Exercising recovery MUST NOT disturb production.
- **FR-020**: The recovery window MUST be stated explicitly.
- **FR-021**: Every rule that destroys data MUST be either recorded as intended
  or corrected. Specifically, the prior-season projection prune MUST be
  reconciled with 002's ratified retention decision.
- **FR-022**: The procedure for rotating each secret MUST be recorded, including
  what becomes unreadable if the credential-encryption key changes.

**Boundaries**

- **FR-023**: This feature MUST NOT change any recommendation rule (Principle IV).
- **FR-024**: This feature MUST NOT add work to the live draft request path.
- **FR-025**: This feature MUST remain read-only against ESPN (Constitution VI).
- **FR-026**: Nothing added here may log or transmit an ESPN credential.

### Key Entities

- **Operational signal**: something the system knows about its own health — a
  job outcome, a session state, a count of things written. Distinct from a log
  line in that something is expected to *read* it.
- **Alert**: a signal that has crossed a threshold and been sent to a person,
  with the affected scope (which league, which account) attached.
- **Check run**: the automated verification of one commit — tests, types, lint,
  privacy — with a pass/fail attributable to that commit.
- **Runbook entry**: a symptom, what it means, and what to do, written for
  someone under time pressure who has not read the code.
- **Recovery procedure**: the steps to restore data, the window within which it
  is possible, and the date it was last exercised.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A failure of a scheduled job is reported to the owner **within one
  hour**, without anyone inspecting logs or the database.
- **SC-002**: A draft session that stops receiving picks during a live draft is
  reported **within five minutes**.
- **SC-003**: A job that produces no output when output was expected is reported
  **within 24 hours**. Today the equivalent took weeks.
- **SC-004**: **100%** of pushes have an automated pass/fail result attributable
  to their commit.
- **SC-005**: A change introducing a forbidden identifier into a fixture is
  **blocked automatically**, and the block names the file without reproducing
  the value.
- **SC-006**: **Zero** credentials, member identifiers or manager names appear
  in any notification or CI output.
- **SC-007**: Someone who has not read the source can diagnose the two most
  likely draft-day failures from the runbook alone.
- **SC-008**: Data recovery has been **executed at least once** against real
  data, with the date and the window recorded.
- **SC-009**: Draft-day behaviour and latency are **unchanged** by this feature.

## Assumptions

Informed defaults where the roadmap left the question open. Each is a decision
`/speckit-clarify` should ratify or overturn.

- **Alerts reach the owner by email**, reusing the Cloudflare Email Service
  already wired for sign-in. It is the only delivery channel the product has,
  the owner already receives mail from it, and adding a second provider for an
  audience of one contradicts Principle VIII. The shared-fate risk is recorded
  as an edge case rather than engineered away.
- **CI is GitHub Actions**, because the repository is already on GitHub. It runs
  the existing `npm test`, `npm run typecheck` and `npm run lint` — no new
  quality gates, just automatic ones.
- **Backups rely on the platform's point-in-time recovery**, verified and
  documented rather than replaced with an export pipeline. Building a second
  backup system for data that is largely reconstructible would be speculative.
- **A single environment is retained.** A staging environment is the obvious
  ask, but the product is deployed continuously by one person, the Worker bundle
  is verified before deploy, and a second environment doubles the surface that
  must be kept in step. This is the assumption most likely to be overturned in
  clarify, and it is deliberately stated so it can be argued with.
- **Alerting is threshold-based on state the system already records** — session
  status, cron outcomes, row counts — rather than a new metrics pipeline.
- **The runbook lives in the repository**, beside the code it describes, so it
  is versioned with the behaviour it documents.

## Dependencies

- **001-league-onboarding** — the deployed Worker, custom domain, D1 migrations,
  encrypted credentials, and Cloudflare Email Service (the alert channel).
- **005-draft-monitor** — the session states alerting reads (`not_receiving`,
  `degraded`, `aborted`), the tap heartbeat, and the archive whose silence is
  itself a signal.
- **010-draft-tap** — the documented limitations the runbook must state, and the
  privacy discipline every alert inherits.
- **011-shared-draft-sessions** — shipped 2026-08-07, after this spec was first
  written, and it changes what an alert has to say. A league's frames are now
  delivered to every entitled manager, so one tap can serve managers who are not
  running it: "the tap stopped" is no longer a fact about the person being
  notified, and "the draft stopped" is meaningless without naming whose. FR-003
  and FR-008 are the requirements this lands on, and FR-005 gets sharper — a
  relayer's identity must not reach a leaguemate through an alert any more than
  through a delivered frame. 011 also added the one reset path and the
  observed-reset void, both of which can destroy a board and neither of which
  reports that it did.
- **002-projections-pipeline** — the prune whose contradiction with its own
  ratified retention decision FR-021 must resolve.
- **008-draft-replay-lab** — the privacy sweep CI will enforce, and the corpus
  whose fixtures it screens.

## Out of Scope

- **Any change to a recommendation rule** (Principle IV).
- **Multi-region or multi-platform deployment.** One platform, ratified in 001.
- **A metrics or dashboard product.** The audience is one person who needs to be
  told when something is wrong, not to watch graphs.
- **On-call rotation, paging, or incident management process.** There is one
  operator.
- **Load testing.** The service has a handful of users and a known ceiling; the
  draft-day path was measured in 005 and 007.
- **Rewriting git history** to remove previously committed data. Decided
  separately by the owner.
- **Closing 005's open items** (draft-end detection, keeper reconciliation).
  They are 005's, and alerting on their silence is what this feature adds.
- **The draft session's scope and lifecycle** — who a session serves, resetting
  one, and how a stale ledger can load a finished draft into a fresh session.
  Found live on 2026-08-06 while preparing a mock draft, and moved to **011**
  rather than absorbed here: 011 changes product behaviour, and 009 changes only
  how the product is operated and observed. Alerting on a session that has died
  stays here; deciding what a session *is* does not.
