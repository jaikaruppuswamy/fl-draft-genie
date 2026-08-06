# Feature Specification: Shared Draft Sessions

**Feature Branch**: `011-shared-draft-sessions`

**Created**: 2026-08-06

**Status**: Draft

**Input**: Five defects found live on 2026-08-06 while preparing a mock draft — one of them a design constraint nobody chose, discovered by the owner asking why it existed.

## Overview

Everything here was found in one evening, seven minutes before a draft, by
trying to use the product for the thing it was built for. None of it was found
by a test. That is the second time in two days the same lesson has arrived:
this project's defects do not announce themselves, and the ones that matter
surface only under real use.

**The organising insight came from a question, not from the code**: *"If a draft
is tapped by one manager in a league, why can't everyone else receive those tap
events?"*

The honest answer is that **nobody decided they shouldn't.** A draft session is
addressed by connection and season, because that is where the owner's team id
lives. Sharing simply never came up. There is no requirement anywhere that
frames must not cross accounts — and the constitution's isolation rule
enumerates *"another user's leagues, credentials, or preferred lists"*, which
does not include the picks in a draft everyone in the room is watching.

The cost is measurable. In the owner's own league on 2026-08-05, a leaguemate's
tap relayed **71 batches** while the owner's relayed **1**. The owner could have
had live picks all evening and received nothing, because the frames were
addressed to somebody else's session.

**This produces the rule the whole feature turns on:**

> **A draft's frames are LEAGUE-SHARED. A manager's perspective — their team,
> their league settings, their preferred list — is PER-ACCOUNT.**

Everything below is a consequence of the system having conflated those two.
Even the tooling defect is: 008's admitting script excluded a leaguemate's
frames when it should only have excluded their *perspective*.

### The five defects

| # | Defect | Consequence |
|---|---|---|
| 1 | Live delivery is scoped to the relaying account | A manager whose leaguemate runs the tap receives nothing |
| 2 | "Cannot reach Draft Genie" is shown when no session is armed | Alarming, wrong, and shown at the worst moment — before a draft |
| 3 | Opening a **completed** draft room relays its full ledger into a fresh session | A finished draft loads into a new one; the board marks ~72 available players as gone |
| 4 | No way to reset a session | The only workaround mints a new connection and destroys the preferred list |
| 5 | Retained frames are scoped by connection, not account | Frames become unreachable after a reconnect, orphaning capture history |

Draft Genie stays **read-only against ESPN** (Constitution VI) and no
recommendation rule changes (Principle IV).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Let me see the draft when a leaguemate is running the tap (Priority: P1) 🎯 MVP

Two managers in one league both use Draft Genie. One has the draft room open and
is relaying. The other opens their draft room and sees the picks — live,
immediately, without installing anything.

**Why this priority**: it is the difference between the product working and not
working for everyone but the one person who happened to install a userscript.
Live monitoring already requires desktop Chrome (010's permanent limitation); a
leaguemate's tap is the only route to live picks for anyone drafting from an
iPad or the ESPN app, which is most people.

**Independent Test**: with one manager relaying and a second manager not, open
the second manager's draft room and confirm picks arrive with their own team
highlighted.

**Acceptance Scenarios**:

1. **Given** a leaguemate is relaying frames for a league and season, **When**
   another manager in that same league opens their draft room, **Then** they see
   the picks as they arrive.
2. **Given** that manager sees the draft, **Then** the board is shown from
   **their** perspective — their team highlighted, their roster, their needs,
   their preferred list — not the relayer's.
3. **Given** two managers in one league have **different** league settings
   recorded, **Then** each sees a board consistent with their own, and a
   disagreement about the draft's shape is surfaced rather than silently
   resolved.
4. **Given** frames arrive from a leaguemate, **Then** nothing identifies who
   relayed them.
5. **Given** a manager is in a league where nobody is relaying, **Then** they are
   told that, and told what would fix it.
6. **Given** a manager is not in the league, **Then** they receive nothing.

---

### User Story 2 - Tell me the truth about why the screen is empty (Priority: P2)

Before the draft starts, the room says it is waiting. When something is actually
wrong, it says that instead — and the two are never confused.

**Why this priority**: this fired at the worst possible moment, seven minutes
before a draft, and it said the product could not be reached when in fact
nothing was wrong at all. A false alarm during the one hour a year that matters
costs exactly the attention the owner does not have. It ranks below US1 only
because US1 is the difference between working and not.

**Independent Test**: open a draft room before any session exists and confirm the
message describes waiting, not failure; then break connectivity and confirm the
message changes.

**Acceptance Scenarios**:

1. **Given** no session has been armed for a league, **When** the draft room is
   opened, **Then** it reports that it is waiting for the draft to start — not
   that Draft Genie cannot be reached.
2. **Given** a session exists but the browser cannot reach the service, **Then**
   the room reports a reachability problem and its remedy.
3. **Given** the service is reachable but picks are not arriving, **Then** the
   room distinguishes that from both cases above — the remedies differ.
4. **Given** any of those states, **Then** the message says what the owner should
   *do*, not only what is true.

---

### User Story 3 - Don't load a finished draft into a new one (Priority: P3)

A tab left open on last week's completed mock does not contaminate tonight's
draft.

**Why this priority**: it silently corrupts the board — a stale ledger marked
~72 available players as already drafted, so every recommendation excluded
players who were genuinely available. Worse than a blank screen, because it
looks like it is working. It ranks below US2 only because it needs a specific
mistake to trigger, while US2 fires every time.

**Independent Test**: with a completed draft room open, arm a fresh session and
confirm the finished draft's picks do not appear.

**Acceptance Scenarios**:

1. **Given** a completed draft's ledger arrives for a session that has no picks,
   **Then** it does not become that session's state.
2. **Given** two ledgers describe different drafts, **Then** the session does not
   choose between them by size alone.
3. **Given** a ledger is rejected as belonging to another draft, **Then** that is
   recorded, so a genuine recovery is never mistaken for contamination.
4. **Given** a draft legitimately resumes after a reload, **Then** its own ledger
   still restores it — the fix must not break recovery, which is what ledgers
   exist for.

---

### User Story 4 - Let me start over without losing anything (Priority: P4)

The owner resets a draft session and runs another mock. Their preferred list,
their league settings and their capture history survive.

**Why this priority**: mock drafts are how the product gets exercised before the
season, and today a second one requires disconnecting the league — which
destroys the preferred list and mints a new connection. It ranks last because a
workaround exists; it is here because the workaround has a cost the owner pays
silently.

**Independent Test**: reset a session, run a second mock, and confirm the new
draft is captured cleanly with the preferred list intact.

**Acceptance Scenarios**:

1. **Given** a completed or abandoned session, **When** the owner resets it,
   **Then** a subsequent draft is captured as a new draft, with none of the
   previous one's picks.
2. **Given** a reset, **Then** the preferred list, league settings and tap
   pairing survive.
3. **Given** a reset, **Then** previously retained frames and any archived draft
   survive — capture history is never destroyed by a reset.
4. **Given** a reset happens while a draft is live, **Then** it is refused or
   confirmed explicitly. It must not be a single unguarded action during a
   draft.

---

### User Story 5 - Keep the capture history reachable (Priority: P5)

Frames captured before a reconnect remain admissible to the replay lab
afterwards.

**Why this priority**: a corpus that silently loses its history defeats 008.
Lowest priority because it affects one maintainer tool rather than the product —
but it is the same root cause, and fixing it anywhere else would leave the
inconsistency.

**Independent Test**: reconnect a league, then admit a draft captured before the
reconnect.

**Acceptance Scenarios**:

1. **Given** a league is disconnected and reconnected, **Then** frames captured
   beforehand remain reachable to the lab.
2. **Given** frames relayed by a leaguemate, **Then** they may be used, while the
   entry's **perspective** comes from the operator's own account.
3. **Given** an entry is built this way, **Then** it records that its frames came
   from another manager's relay.
4. **Given** any admission, **Then** it remains impossible to build an entry
   carrying another account's team, settings or preferred list.

---

### Edge Cases

- **Two managers in one league disagree about the draft's shape.** Observed: one
  recorded an 11-round roster, the other 12, for the same draft.
- **A leaguemate stops relaying mid-draft.** Everyone depending on that tap loses
  the feed at once.
- **Two managers relay the same draft simultaneously**, producing duplicate
  frames for the same picks.
- **A manager leaves the league** but their connection lingers.
- **A leaguemate relays a draft the other manager is not in** — a different
  league, or a mock.
- **A ledger arrives for a draft that has genuinely resumed after a crash**, and
  must be honoured; distinguishing this from contamination is the hard part of
  US3.
- **A reset is requested while a draft is live.**
- **A manager who has never connected the league** receives frames addressed to
  it.
- **Every manager in a league is on an iPad**, so nobody can relay at all.
- **A leaguemate's league settings are stale**, so shared frames reconcile
  against a wrong total.

## Requirements *(mandatory)*

### Functional Requirements

**League-shared delivery (US1)**

- **FR-001**: Frames relayed for a league and season MUST be delivered to every
  manager who has connected that league and season.
- **FR-002**: Each manager's view MUST be rendered from **their own**
  perspective — their team, league settings, roster needs and preferred list.
- **FR-003**: The system MUST NOT disclose which manager relayed the frames.
- **FR-004**: A manager who has not connected a league MUST receive nothing for
  it.
- **FR-005**: Where two managers' recorded league settings disagree about the
  draft's shape, the disagreement MUST be surfaced rather than silently
  resolved.
- **FR-006**: A manager in a league with no active relay MUST be told so, and
  told what would change it.
- **FR-007**: Delivery MUST remain within the latency budget 005 ratified.

**Honest state reporting (US2)**

- **FR-008**: When no session is armed, the draft room MUST report that it is
  waiting for the draft, and MUST NOT report a reachability failure.
- **FR-009**: The room MUST distinguish, in what it shows: waiting for a draft;
  cannot reach the service; and reachable but not receiving picks.
- **FR-010**: Each state MUST state the remedy, not only the condition.
- **FR-011**: A transient reconnection MUST NOT present as a failure while it is
  still expected to succeed.

**Ledger containment (US3)**

- **FR-012**: A ledger describing a different draft MUST NOT become a session's
  state.
- **FR-013**: Ledger selection MUST NOT rest on coverage alone.
- **FR-014**: A rejected ledger MUST be recorded with the reason.
- **FR-015**: A ledger belonging to the session's own draft MUST still restore
  it after a reload or crash.

**Session reset (US4)**

- **FR-016**: The owner MUST be able to reset a draft session so the next draft
  is captured as a new one.
- **FR-017**: A reset MUST preserve the preferred list, league settings and tap
  pairing.
- **FR-018**: A reset MUST preserve retained frames and any archived draft.
- **FR-019**: A reset during a live draft MUST be refused or explicitly
  confirmed.
- **FR-020**: A reset MUST leave the session able to arm again — not disabled.

**Capture reachability (US5)**

- **FR-021**: Frames MUST remain reachable to the replay lab across a
  disconnect and reconnect of the league.
- **FR-022**: A corpus entry MAY use frames relayed by any manager of that
  league, and MUST take its perspective from the operator's own account.
- **FR-023**: An entry built from a leaguemate's frames MUST record that.
- **FR-024**: It MUST remain impossible to build an entry carrying another
  account's team, settings or preferred list.

**Boundaries**

- **FR-025**: No recommendation rule changes (Principle IV).
- **FR-026**: Read-only against ESPN; no draft-room connection (Constitution VI).
- **FR-027**: No ESPN credential is logged, transmitted or exposed.
- **FR-028**: Frames crossing between managers MUST carry only what the tap
  already relays — numeric identifiers, no names, no member identifiers.

### Key Entities

- **Draft**: the shared event — a league, a season, an ordered set of picks. The
  thing several managers observe at once. Distinct from any one manager's view.
- **Relay**: a manager's tap supplying frames for a draft. Any manager may be
  the relay; the draft does not belong to them.
- **Perspective**: one manager's account-specific context — their team, league
  settings, roster needs, preferred list. Never shared, never inferred from
  whoever relayed.
- **Session state**: what the room shows and why — waiting, reachable, not
  receiving — each with a remedy.
- **Reset**: returning a session to un-started without destroying perspective or
  capture history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A manager who is **not** relaying sees picks from a leaguemate's
  relay, within the same latency budget as the relayer.
- **SC-002**: **100%** of delivered views show the viewing manager's own team and
  roster — never the relayer's.
- **SC-003**: **Zero** views disclose who relayed the frames.
- **SC-004**: Opening a draft room before any session exists reports **waiting**,
  not failure, **100%** of the time.
- **SC-005**: A completed draft's ledger arriving at a fresh session results in
  **zero** of its picks entering that session, and the rejection is recorded.
- **SC-006**: A legitimate reload still restores the draft in progress — the
  containment fix breaks **no** recovery case.
- **SC-007**: After a reset, a second mock is captured with **none** of the first
  draft's picks, and the preferred list is **unchanged**.
- **SC-008**: Frames captured before a reconnect remain admissible **100%** of
  the time afterwards.
- **SC-009**: **Zero** corpus entries can be produced carrying another account's
  perspective.
- **SC-010**: Draft-day latency is **unchanged** for the relaying manager.

## Assumptions

Informed defaults where the finding did not settle the question. Each is a
decision `/speckit-clarify` should ratify or overturn.

- **Sharing is automatic within a league, not opt-in.** A draft is a shared
  event and the picks are visible to every manager in the room already, so
  consent to *receive* is not required. Whether a manager consents to their tap
  *serving* others is the sharper question, and the one most likely to be
  overturned.
- **The relayer stays anonymous.** Managers learn that a relay exists, never
  whose. This avoids disclosing that a particular person uses the product,
  which is the only genuinely private fact in the exchange.
- **Where managers' league settings disagree, each manager's own settings drive
  their own view**, and the disagreement is reported. Nobody's view is silently
  rewritten by someone else's stale sync.
- **A ledger is bound to the draft it belongs to** by something stronger than
  size. Exactly what — a start time, a first pick, an explicit identity — is a
  design question for planning, not a spec decision.
- **Reset is an owner action in the app**, not an automatic recovery.
- **The existing latency budget is unchanged.** Fanning out to a handful of
  managers is not expected to move it, and SC-010 exists to check rather than
  assume.

## Dependencies

- **005-draft-monitor** — the session, its reconciler, its ledger handling and
  its latency budget. Four of the five defects live here.
- **010-draft-tap** — the relay, its pairing, and the numeric-only discipline
  that shared frames inherit unchanged.
- **007-draft-room-ui** — where session state is reported, and where a manager's
  perspective is rendered.
- **008-draft-replay-lab** — the admitting path US5 corrects, and the
  frames-versus-perspective rule this feature generalises.
- **001-league-onboarding** — the league connection, whose lifecycle US4's reset
  exists to avoid abusing.

## Out of Scope

- **Any recommendation rule change** (Principle IV).
- **Relaying for a league nobody has connected.** A relay serves managers of that
  league, not the public.
- **Making the tap unnecessary.** Gate 0 stands: no ESPN read API sees a live
  draft. This shares one tap; it does not remove the need for one.
- **Multiple simultaneous relays as a resilience feature.** Duplicate frames must
  not corrupt anything (an edge case), but coordinated failover is not built.
- **Cross-league or cross-season sharing.**
- **Closing 005's open items** (draft-end detection, keeper reconciliation).
- **009's operational concerns** — alerting that a session died belongs there;
  deciding what a session *is* belongs here.
