# Feature Specification: Shared Draft Sessions

**Feature Branch**: `011-shared-draft-sessions`

**Created**: 2026-08-06

**Status**: Draft

**Input**: Five defects found live on 2026-08-06 while preparing a mock draft, plus the owner's request to simplify tap setup. Originally split as 011 + 012; **combined 2026-08-06** because they are two halves of one sentence — *nobody should have to pair anything* — and splitting them would have produced two specs arguing about the same boundary. 012 is cancelled and records the merge.

## Overview

Everything here was found in one evening, seven minutes before a draft, by
trying to use the product for the thing it was built for. None of it was found
by a test. That is the second time in two days the same lesson has arrived: this
project's defects do not announce themselves, and the ones that matter surface
only under real use.

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

### Two rules, and everything follows

> **1. A draft's frames are LEAGUE-SHARED. A manager's perspective — their team,
> their league settings, their preferred list — is PER-ACCOUNT.**
>
> **2. A relay must prove which account it acts for. The user must never be the
> one holding the proof.**

Rule 1 governs who may receive. Rule 2 governs who may send. Together they are
the whole answer to *"nobody should have to pair anything"* — which is why these
were combined rather than specified apart.

### Why rule 2 keeps a credential

The tap runs on ESPN's page, where Draft Genie's sign-in does not reach. That is
the entire reason 010 invented an ingest credential.

Removing it would leave the ingest an **unauthenticated public write endpoint**.
Anyone who learned a league identifier could inject fabricated picks into a live
draft, and the engine would advise against a corrupted board — the product's core
function, failing at the one moment it exists for, while everything looked
normal. 010 sized the blast radius deliberately: *"if a token leaks: append draft
messages for this account's own leagues. It can never read league data and never
reaches ESPN."* That bound exists **because** the credential names an account.

**So the credential stays and stops being the user's problem.** The userscript
already runs on ESPN's origin; it can also recognise Draft Genie's own page, so a
signed-in acknowledgement hands the browser what it needs. Install, click, done —
no codes, nothing copied, nothing to curate. Exactly the requested experience;
only the handling moves.

**This was put to the owner directly and ratified** (see Clarifications), with
removing the credential and narrowing it to live-draft windows both on the table
and both rejected. It is a decision, not a default arrived at by simplifying a
page.

### The defects

| # | Defect | Consequence |
|---|---|---|
| 1 | Live delivery is scoped to the relaying account | A manager whose leaguemate relays receives nothing |
| 2 | Tap setup requires hand-handling a credential | The only such step in the product; it broke under time pressure |
| 3 | State is not legible — on the tap page or in the draft room | A working tap looked broken; "cannot reach" showed when nothing was wrong |
| 4 | A **completed** draft room's ledger loads into a fresh session | ~72 available players marked gone; looks like it works |
| 5 | No way to reset a session | Workaround mints a new connection and destroyed a preferred player |
| 6 | Retained frames scoped by connection, not account | A reconnect orphans capture history |
| 7 | A draft reset **in ESPN** is seen by sync and acted on by nothing | The stale session swallows the next draft; both status transitions are latched on `completed_at IS NULL` |
| 8 | A session can hold `completed_at` while its status says `armed` | Observed live 2026-08-06. Arming writes status directly and bypasses the latch, leaving a session that can never transition to `live` — because that transition requires `completed_at IS NULL` |

Draft Genie stays **read-only against ESPN** (Constitution VI) — the tap remains
strictly passive — and no recommendation rule changes (Principle IV).

## Clarifications

### Session 2026-08-06

- Q: Should the ingest keep requiring a credential that proves which account a relay acts for, or accept relayed picks without one? → A: **Keep it; the user stops handling it.** A signed-in acknowledgement hands the browser what it needs, so setup is install-click-done with nothing shown, copied or curated — but the ingest still rejects anything it cannot attribute to an account. The blast radius stays as 010 sized it: append draft messages for that account's own leagues, never read league data, never reach ESPN. **Removing the credential is rejected**, and so is narrowing it to live-draft windows only — that constraint is weakest exactly when a draft is live, which is when fabricated picks would do the damage.
- Q: When one manager's tap is relaying a draft, should their leaguemates automatically receive it, or should that manager have to agree to serve them? → A: **Automatic.** Every manager who has connected the league receives what is relayed, with no setting to find on either side and no coordination between them. The relaying manager is not asked and is not identified. Rationale: the picks were never private — they are on every manager's screen in ESPN already — the relay costs the volunteer nothing they were not already doing, and an opt-in nobody finds means the feature silently does not exist for the managers who most need it, the ones on an iPad who cannot relay at all.
- Q: When the manager who is relaying closes their laptop mid-draft, what should the other managers who were depending on that relay see? → A: **Say the feed has stopped, and say what would restore it — the same message to everyone.** One message rather than one per audience: "someone in this league needs a draft room open in desktop Chrome" is actionable by anyone, including a manager on an iPad who can act socially rather than technically. The requirement is that a stopped feed is never indistinguishable from a draft that has not started.
- Q: If the owner signs out of Draft Genie, should the tap in that browser keep relaying? → A: **Keep relaying; revocable from the tap page.** Enablement is a property of the browser, not the session, so it survives sign-out and session expiry and still expires on its own schedule. The failure modes are asymmetric: a stale enablement leaks nothing — the tap can only append picks for that account's own leagues and can never read — whereas a relay dying mid-draft now breaks the feed for that manager's **whole league**, at the moment it matters most.
- Q: When two managers in the same league are both relaying the same draft, should the system accept both streams or elect one? → A: **Accept all relays and treat duplicates as the same pick.** A second relay is free resilience against exactly the single point of failure US1 creates, and electing a primary would require failover that detects a dead relay and promotes a replacement mid-draft — a path that would never be exercised until the night it mattered. Duplicates must converge on one pick rather than being counted twice, and a later frame that *corrects* an earlier one must not be discarded merely for arriving second.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Let me see the draft when a leaguemate is running the tap (Priority: P1) 🎯 MVP

Two managers in one league both use Draft Genie. One has the draft room open and
is relaying. The other opens their draft room and sees the picks — live,
immediately, without installing anything.

**Why this priority**: it is the difference between the product working and not
working for everyone but the one person who installed a userscript. Live
relaying needs desktop Chrome (010's permanent limitation), so a leaguemate's tap
is the **only** route to live picks for anyone drafting from an iPad or the ESPN
app — which is most people. This is a reach problem, not a convenience.

**Independent Test**: with one manager relaying and a second not, open the second
manager's draft room and confirm picks arrive with their own team highlighted.

**Acceptance Scenarios**:

1. **Given** a leaguemate is relaying for a league and season, **When** another
   manager in that league opens their draft room, **Then** they see picks as they
   arrive.
2. **Given** that manager sees the draft, **Then** the board is shown from
   **their** perspective — their team, roster, needs and preferred list — not the
   relayer's.
3. **Given** two managers have **different** league settings recorded, **Then**
   each sees a board consistent with their own, and a disagreement about the
   draft's shape is surfaced rather than silently resolved.
4. **Given** frames arrive from a leaguemate, **Then** nothing identifies who
   relayed them.
5. **Given** nobody in the league is relaying, **Then** the manager is told that,
   and told what would fix it.
6. **Given** a manager is not in the league, **Then** they receive nothing.

---

### User Story 2 - Tell me the truth about what is working (Priority: P2)

Both surfaces — the tap page and the draft room — say plainly what state things
are in, and never mistake one failure for another.

**Why this priority**: this is what actually went wrong. The tap was **working**;
nobody could tell. So setup was re-done twice under time pressure, revoking a
working credential each time — three pairings in fourteen minutes — while the
draft room simultaneously claimed Draft Genie could not be reached, when nothing
was wrong at all. A one-click setup that is still opaque would have produced the
identical evening, which is why this outranks the convenience it enables.

**Independent Test**: put each surface into each of its states and confirm every
one is reported distinctly, with a remedy.

**Acceptance Scenarios**:

1. **Given** the tap page, **Then** it distinguishes: not installed; installed
   but not enabled; enabled but idle; actively relaying.
2. **Given** an active relay, **Then** it is evidenced by when it last relayed —
   not asserted.
3. **Given** a tap that was working and has stopped, **Then** that is
   distinguished from one never enabled.
4. **Given** no session has been armed, **When** the draft room is opened,
   **Then** it reports that it is waiting for the draft — **not** that Draft
   Genie cannot be reached.
5. **Given** a session exists but the browser cannot reach the service, **Then**
   the room reports a reachability problem.
6. **Given** the service is reachable but picks are not arriving, **Then** the
   room distinguishes that from both cases above — the remedies differ.
7. **Given** any state on either surface, **Then** it says what to *do*, not only
   what is true.
8. **Given** a state is indeterminate, **Then** it says unknown rather than
   guessing.

---

### User Story 3 - Set the tap up in one step (Priority: P3)

The owner installs the userscript, opens the tap page while signed in, clicks
once, and the tap is live. Nothing is copied, entered or remembered.

**Why this priority**: the owner's request, and the removal of the only step in
the product where a user handles a credential by hand. It ranks below US2 because
legibility is what prevents the failure; this removes the friction that made
people reach for the fix.

**Independent Test**: from a browser with no prior setup, install the script and
enable the tap without typing or pasting anything, then relay from a draft room.

**Acceptance Scenarios**:

1. **Given** the script is installed and the owner is signed in, **When** they
   acknowledge once, **Then** the tap is enabled with no value shown, copied or
   retained by the user.
2. **Given** the tap is enabled, **When** an ESPN draft room is opened, **Then**
   frames relay without further action.
3. **Given** the owner is not signed in, **Then** they are asked to sign in
   rather than shown a failure.
4. **Given** the tap is already enabled here, **Then** acknowledging again is
   harmless and does not disturb a relay in progress.
5. **Given** enabling fails, **Then** the reason is stated and any previously
   working state is left intact.
6. **Given** any relay, **Then** its frames remain attributable to exactly one
   account, and that account's own leagues only.

---

### User Story 4 - Don't load a finished draft into a new one (Priority: P4)

A tab left open on last week's completed mock does not contaminate tonight's
draft.

**Why this priority**: it silently corrupts the board — a stale ledger marked ~72
available players as already drafted, so every recommendation excluded players
who were genuinely available. Worse than a blank screen, because it looks like it
is working. Below US3 only because it needs a specific mistake to trigger.

**Independent Test**: with a completed draft room open, arm a fresh session and
confirm the finished draft's picks do not appear.

**Acceptance Scenarios**:

1. **Given** a completed draft's ledger arrives for a session with no picks,
   **Then** it does not become that session's state.
2. **Given** two ledgers describe different drafts, **Then** the session does not
   choose between them by size alone.
3. **Given** a ledger is rejected, **Then** that is recorded, so a genuine
   recovery is never mistaken for contamination.
4. **Given** a draft legitimately resumes after a reload, **Then** its own ledger
   still restores it — the fix must not break recovery, which is what ledgers
   exist for.

---

### User Story 5 - Let me start over without losing anything (Priority: P5)

The owner resets a draft session and runs another mock. Their preferred list,
league settings, tap enablement and capture history survive.

**Why this priority**: mock drafts are how the product gets exercised before the
season, and a second one currently requires disconnecting the league — which
destroys the preferred list and mints a new connection. A workaround exists; it
has a cost the owner pays silently.

**Why this is not made redundant by US8** (asked directly, 2026-08-06):
**ESPN's league record never reflects a mock draft.** Measured that day:
`started=0, completed=0, scheduled_at=null` for a league in which two 72-pick
drafts had been captured. US8 keys on a change in ESPN's report, so for a mock
there is nothing to observe and syncing cleans up nothing. The two stories cover
**disjoint** cases — US8 handles real drafts reset in ESPN, US5 handles
everything ESPN cannot see, which is every mock. They share one `reset()`
implementation (T061) so there is one behaviour reached two ways, not two
behaviours.

**Independent Test**: reset a session, run a second mock, and confirm the new
draft is captured cleanly with the preferred list intact.

**Acceptance Scenarios**:

1. **Given** a completed or abandoned session, **When** the owner resets it,
   **Then** a subsequent draft is captured as a new draft with none of the
   previous one's picks.
2. **Given** a reset, **Then** the preferred list, league settings and tap
   enablement survive.
3. **Given** a reset, **Then** retained frames and any archived draft survive —
   capture history is never destroyed by a reset.
4. **Given** a reset during a live draft, **Then** it is refused or explicitly
   confirmed.
5. **Given** a reset, **Then** the session can arm again — it is not disabled.

---

### User Story 8 - Notice when ESPN says the draft was reset (Priority: P6)

The owner resets the draft in ESPN and runs it again. Draft Genie notices at the
next sync, voids the stale session, and captures the new draft cleanly — without
the owner touching anything, and without losing the record of the draft that was
reset.

*(Story id 8, priority 6 — the two stories below it were written first and
renumbering seven stories and fifty-eight tasks to insert one buys nothing.)*

**Why this priority**: it is the same outcome as US5 arrived at automatically,
and it covers the case that actually happened — the draft was reset in **ESPN**,
not in Draft Genie, so no app action was ever going to fire. It ranks below the
manual reset because that is the deterministic route and this one depends on
ESPN reporting truthfully; it ranks above the page and the lab because a stale
session silently swallows the next draft.

**Verified 2026-08-06**: the sync already **sees** this — `mDraftDetail` is in
the refresh view set and the completion flag lands in the stored snapshot — and
nothing acts on it. Both session-status transitions are guarded on
`completed_at IS NULL`, so once a draft completes the state cannot move back by
any route.

**Independent Test**: complete a draft, reset it in ESPN, sync, and confirm the
next draft is captured as a new draft with none of the previous one's picks.

**Acceptance Scenarios**:

1. **Given** a session recorded as complete, **When** a sync observes that ESPN
   no longer reports that draft as completed, **Then** the session is voided and
   can arm again for a new draft.
2. **Given** the session is voided, **Then** every manager's session for that
   league and season is voided — under shared delivery there is more than one.
3. **Given** a voided session, **Then** the frames and any archived record of the
   draft that was reset **survive**. Voiding a session must never destroy the
   record of a draft that really happened.
4. **Given** a draft is **currently receiving picks**, **Then** no sync result
   may void it. A transient or incorrect response must not be able to wipe a
   live draft.
5. **Given** a session is voided, **Then** the reason and the observation that
   triggered it are recorded, so an unexpected void can be explained afterwards.
6. **Given** ESPN's report is unavailable or ambiguous, **Then** nothing is
   voided — absence of evidence is not evidence of a reset.

---

### User Story 6 - Simplify the Draft Tap page to match (Priority: P7)

With setup reduced to install-and-acknowledge, the page loses its pairing
instructions and keeps installation, state, and a way to turn the tap off.

**Why this priority**: follows from US3 rather than standing alone. Documentation
describing a flow that no longer exists is confusing, not dangerous.

**Independent Test**: give the page to someone who has never set the tap up and
confirm they succeed without asking a question.

**Acceptance Scenarios**:

1. **Given** the simplified page, **Then** it covers installing, enabling and
   current state, and no longer instructs anyone to pair a browser or handle a
   credential.
2. **Given** the owner wants to stop relaying, **Then** the page provides that
   and says what stops — including that ESPN is unaffected.
3. **Given** several browsers are enabled, **Then** each is listable and
   individually revocable.
4. **Given** the product's limitation, **Then** the page still states that live
   relaying needs desktop Chrome.

---

### User Story 7 - Keep the capture history reachable (Priority: P8)

Frames captured before a reconnect remain admissible to the replay lab
afterwards.

**Why this priority**: a corpus that silently loses its history defeats 008.
Lowest because it affects one maintainer tool rather than the product — but it is
the same root cause, and fixing it elsewhere would leave the inconsistency.

**Independent Test**: reconnect a league, then admit a draft captured before the
reconnect.

**Acceptance Scenarios**:

1. **Given** a league is disconnected and reconnected, **Then** frames captured
   beforehand remain reachable to the lab.
2. **Given** frames relayed by a leaguemate, **Then** they may be used, while the
   entry's **perspective** comes from the operator's own account.
3. **Given** an entry built this way, **Then** it records that its frames came
   from another manager's relay.
4. **Given** any admission, **Then** it remains impossible to build an entry
   carrying another account's team, settings or preferred list.

---

### Edge Cases

- **Two managers in one league disagree about the draft's shape.** Observed: one
  recorded an 11-round roster, the other 12, for the same draft.
- **A leaguemate stops relaying mid-draft.** Everyone depending on that tap loses
  the feed at once.
- **Two browsers, profiles or managers relay the same draft simultaneously**,
  producing duplicate frames.
- **A ledger arrives for a draft that genuinely resumed after a crash**, and must
  be honoured — distinguishing this from contamination is the hard part of US4.
- **The owner is signed in as one account and drafting a league connected under
  another.** Which account does the relay act for?
- **Sign-out.** Does an enabled tap keep relaying, and should it?
- **A credential expires mid-draft.** They carry a stated lifetime today.
- **A hostile page tries to trigger enablement** without the owner's intent.
- **The userscript updates** and must not require re-acknowledgement.
- **Every manager in a league is on an iPad**, so nobody can relay at all.
- **A manager leaves the league** but their connection lingers.
- **A reset is requested while a draft is live.**
- **A mock draft is captured.** ESPN's league record never reflects it, so no
  sync-based cleanup can ever apply — this is why US5 exists alongside US8.
- **A real draft finishes.** The tap knows within seconds; ESPN's flush lands
  later. Nothing may void the session during that window.
- **ESPN reports a draft as not-completed transiently**, or the field is missing
  from a partial response — this must never void a live draft.
- **A draft is reset in ESPN after it was archived.** The archive is history and
  survives; only the session is voided.
- **The tap page is opened on a device that cannot run the script**, which is the
  common case for other managers.

## Requirements *(mandatory)*

### Functional Requirements

**League-shared delivery (US1)**

- **FR-001**: Frames relayed for a league and season MUST be delivered to every
  manager who has connected that league and season.
- **FR-002**: Each manager's view MUST be rendered from **their own**
  perspective — team, league settings, roster needs, preferred list.
- **FR-003**: The system MUST NOT disclose which manager relayed the frames.
- **FR-003a**: Sharing MUST require no setting, consent step or coordination on
  either side. The relaying manager is not asked, and no manager needs to enable
  receiving. A control that must be found is a control that will not be found by
  the managers who need this most — the ones who cannot relay at all.
- **FR-004**: A manager who has not connected a league MUST receive nothing for
  it.
- **FR-005**: Where managers' recorded league settings disagree about the draft's
  shape, the disagreement MUST be surfaced, not silently resolved.
- **FR-006**: A manager in a league with no active relay MUST be told so, and
  told what would change it.
- **FR-006a**: A relay that **stops mid-draft** MUST be reported to every manager
  depending on it, and MUST NOT be presentable as a draft that has not started.
  The message MUST be the same for all of them and MUST name the remedy — a
  manager who cannot relay can still act on it by asking one who can.
- **FR-007**: Delivery MUST remain within the latency budget 005 ratified.
- **FR-007a**: Frames from **several relays** for one draft MUST all be accepted,
  and duplicates describing the same pick MUST converge on one pick rather than
  being counted twice. A second relay is resilience against the single point of
  failure shared delivery creates, so it is never rejected.
- **FR-007b**: A later frame that **corrects** an earlier one MUST NOT be
  discarded merely for arriving second. Duplicate suppression must not become
  first-writer-wins on a changed fact.

**Honest state (US2)**

- **FR-008**: The tap page MUST distinguish: not installed; installed but not
  enabled; enabled but idle; actively relaying.
- **FR-009**: An active relay MUST be evidenced by when it last relayed, not
  asserted.
- **FR-010**: A tap that has stopped MUST be distinguishable from one never
  enabled.
- **FR-011**: When no session is armed, the draft room MUST report that it is
  waiting for the draft, and MUST NOT report a reachability failure.
- **FR-012**: The room MUST distinguish: waiting for a draft; cannot reach the
  service; reachable but not receiving picks.
- **FR-013**: Every reported state MUST state the remedy, not only the condition.
- **FR-014**: A transient reconnection MUST NOT present as failure while it is
  still expected to succeed.
- **FR-015**: An indeterminate state MUST be reported as unknown.

**One-step enablement (US3)**

- **FR-016**: The owner MUST be able to enable the tap with a single
  acknowledgement, having installed the script and signed in.
- **FR-017**: No credential, code or identifier may be shown to, copied by, or
  retained by the user.
- **FR-018**: Enabling MUST require a genuine user action; it MUST NOT be
  triggerable by a page the owner merely visits.
- **FR-019**: Enabling MUST require an authenticated session, and the relay MUST
  act only for that account.
- **FR-020**: Re-acknowledging MUST be safe and MUST NOT interrupt a relay in
  progress.
- **FR-020a**: Relay enablement MUST survive sign-out and session expiry, and
  MUST remain revocable from the tap page. It is a property of the browser, not
  of a signed-in session — a draft outlasts a session, and under league-shared
  delivery a relay that dies mid-draft takes the whole league's feed with it.
- **FR-021**: A failure to enable MUST state why and leave any working state
  intact.
- **FR-022**: The ingest MUST continue to reject unattributable frames. This
  feature changes **who handles** the credential, never **whether one exists**.
- **FR-022a**: Attribution MUST NOT be inferred from context in place of a
  credential — not from a league having an armed session, not from a draft being
  in progress, not from the league identifier alone. Those constraints are
  weakest precisely while a draft is live, which is when injected picks would do
  the damage.

**Ledger containment (US4)**

- **FR-023**: A ledger describing a different draft MUST NOT become a session's
  state.
- **FR-024**: Ledger selection MUST NOT rest on coverage alone.
- **FR-025**: A rejected ledger MUST be recorded with the reason.
- **FR-026**: A ledger belonging to the session's own draft MUST still restore it
  after a reload or crash.

**Session reset (US5)**

- **FR-027**: The owner MUST be able to reset a session so the next draft is
  captured as a new one.
- **FR-028**: A reset MUST preserve the preferred list, league settings and tap
  enablement.
- **FR-029**: A reset MUST preserve retained frames and any archived draft.
- **FR-030**: A reset during a live draft MUST be refused or explicitly
  confirmed.
- **FR-031**: A reset MUST leave the session able to arm again.
- **FR-031g**: A session MUST NOT be able to hold a completion stamp while
  reporting a pre-completion status. Observed live 2026-08-06: arming writes
  status directly and bypasses the completion latch, leaving a session marked
  `armed` while carrying `completed_at` — which can never transition to `live`,
  because that transition requires `completed_at IS NULL`. Reset MUST clear both
  together, and arming MUST NOT produce the split state.

**Reset observed from ESPN (US8)**

- **FR-031a**: A sync that observes ESPN reporting a draft as **no longer
  completed, having previously reported it completed**, MUST void the
  corresponding session so it can arm again.
- **FR-031a1**: The trigger MUST be a change in **ESPN's own** report, never a
  disagreement between Draft Genie's session and ESPN. Two verified reasons:
  **(a)** mock drafts never appear in ESPN's league draft record at all —
  measured 2026-08-06, `started=0, completed=0` for a league in which two 72-pick
  drafts had been captured — so a disagreement rule would fire endlessly for
  them; and **(b)** the tap observes a real draft finishing seconds after the
  last pick while ESPN's post-completion flush lands later, so a disagreement
  rule would void a genuinely finished draft during that window, before it is
  archived.
- **FR-031b**: Voiding MUST apply to **every** manager's session for that league
  and season, not only the one whose sync observed it.
- **FR-031c**: Voiding a session MUST NOT destroy retained frames or any
  archived record of the draft that was reset. A draft that really happened
  remains history.
- **FR-031d**: A session that is **currently receiving picks** MUST NOT be
  voided by any sync result. A transient or wrong response must never be able to
  wipe a live draft.
- **FR-031e**: Every void MUST record its reason and the observation that
  triggered it.
- **FR-031f**: Where ESPN's report is unavailable or ambiguous, nothing is
  voided — absence of evidence is not evidence of a reset.

**The tap page (US6)**

- **FR-032**: The page MUST cover installing, enabling and current state, and
  MUST NOT instruct anyone to pair a browser or handle a credential.
- **FR-033**: The owner MUST be able to stop relaying from that page, with the
  effect stated — including that ESPN is unaffected.
- **FR-034**: Where several browsers are enabled, each MUST be listable and
  individually revocable.
- **FR-035**: The page MUST state that live relaying requires desktop Chrome.

**Capture reachability (US7)**

- **FR-036**: Frames MUST remain reachable to the replay lab across a disconnect
  and reconnect.
- **FR-037**: A corpus entry MAY use frames relayed by any manager of that
  league, and MUST take its perspective from the operator's own account.
- **FR-038**: An entry built from a leaguemate's frames MUST record that.
- **FR-039**: It MUST remain impossible to build an entry carrying another
  account's team, settings or preferred list.

**Boundaries**

- **FR-040**: No recommendation rule changes (Principle IV).
- **FR-041**: Read-only against ESPN; the tap stays strictly passive, opens no
  connection and has no send path to ESPN (Constitution VI).
- **FR-042**: No ESPN credential is read, logged, stored or transmitted by the
  tap.
- **FR-043**: Frames crossing between managers MUST carry only what the tap
  already relays — numeric identifiers, no names, no member identifiers.

### Key Entities

- **Draft**: the shared event — a league, a season, an ordered set of picks. What
  several managers observe at once. Distinct from any one manager's view.
- **Relay**: a browser supplying frames for a draft, acting for exactly one
  account. Any manager may be the relay; the draft does not belong to them.
- **Relay enablement**: the state of one browser being permitted to relay for one
  account. Created by acknowledgement, revocable, never handled by the user.
- **Perspective**: one manager's account-specific context — team, league
  settings, roster needs, preferred list. Never shared, never inferred from
  whoever relayed.
- **Observable state**: what each surface reports and why — the tap's four
  states, the room's three — each with a remedy.
- **Reset**: returning a session to un-started without destroying perspective,
  enablement or capture history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A manager who is **not** relaying sees picks from a leaguemate's
  relay, within the same latency budget as the relayer.
- **SC-002**: **100%** of delivered views show the viewing manager's own team and
  roster — never the relayer's.
- **SC-003**: **Zero** views disclose who relayed the frames.
- **SC-004**: A new user goes from nothing to a relaying tap in **one
  acknowledgement** after installing the script, with **zero** values typed or
  pasted, and **zero** credentials displayed.
- **SC-005**: All four tap states and all three draft-room states are reported
  distinctly, **100%** of the time, each with a remedy.
- **SC-006**: An active relay is evidenced by a last-relayed time, never by an
  unsupported claim of health.
- **SC-007**: A completed draft's ledger arriving at a fresh session results in
  **zero** of its picks entering that session, and the rejection is recorded.
- **SC-008**: A legitimate reload still restores the draft in progress — the
  containment fix breaks **no** recovery case.
- **SC-009**: After a reset, a second mock is captured with **none** of the first
  draft's picks, and the preferred list is **unchanged**.
- **SC-009a**: A draft reset in ESPN is noticed at the next sync and the next
  draft is captured with **none** of the previous one's picks — with no action by
  the owner.
- **SC-009b**: **Zero** live drafts are ever voided by a sync result.
- **SC-010**: Frames captured before a reconnect remain admissible **100%** of
  the time afterwards.
- **SC-011**: **Zero** corpus entries can be produced carrying another account's
  perspective.
- **SC-012**: The ingest continues to reject **100%** of unattributable frames,
  and enablement cannot be caused by a page the owner merely visits.
- **SC-013**: Draft-day latency is **unchanged** for the relaying manager, and
  the tap performs **zero** writes toward ESPN.

## Assumptions

Informed defaults. Each is a decision `/speckit-clarify` should ratify or
overturn — the first especially.

- ~~The credential remains; the user stops handling it.~~ **RATIFIED** in
  Clarifications, deliberately and with the alternatives on the table. No longer
  an assumption: see FR-022 and FR-022a.
- ~~Sharing is automatic within a league, not opt-in.~~ **RATIFIED** in
  Clarifications — no setting on either side, and the relayer is neither asked
  nor identified. See FR-003a.
- **The relayer stays anonymous.** Managers learn a relay exists, never whose —
  which avoids disclosing that a particular person uses the product, the only
  genuinely private fact in the exchange.
- **Where managers' league settings disagree, each manager's own settings drive
  their own view**, and the disagreement is reported.
- **A ledger is bound to the draft it belongs to** by something stronger than
  size. Exactly what is a design question for planning.
- ~~Enablement is per browser and outlives a sign-out.~~ **RATIFIED** in
  Clarifications. See FR-020a.
- **A credential lifetime is retained** (010 FR-014a), renewed silently where the
  owner is signed in.
- **Reset is an owner action in the app**, not automatic recovery.
- **Desktop Chrome remains the only relaying platform** — 010's permanent
  limitation, restated rather than revisited.

## Dependencies

- **005-draft-monitor** — the session, its reconciler, its ledger handling and
  its latency budget. Most of this feature lives here.
- **010-draft-tap** — the userscript, the ingest, the credential model whose
  *handling* changes, and the passivity constraint that does not.
- **007-draft-room-ui** — where session state is reported and a manager's
  perspective is rendered.
- **008-draft-replay-lab** — the admitting path US7 corrects, and the
  frames-versus-perspective rule this feature generalises.
- **001-league-onboarding** — the league connection whose lifecycle US5's reset
  exists to avoid abusing, and the sign-in that authenticates enablement.

## Out of Scope

- **Any recommendation rule change** (Principle IV).
- **Removing the credential from the ingest.** Explicitly rejected above; a
  change to that is its own decision with its own record.
- **Relaying for a league nobody has connected.** A relay serves managers of that
  league, not the public.
- **Making the tap unnecessary.** Gate 0 stands: no ESPN read API sees a live
  draft. This shares one tap; it does not remove the need for one.
- **Relaying from platforms other than desktop Chrome.**
- **Coordinated relay failover.** Several simultaneous relays are accepted and
  deduplicated (FR-007a) — which *is* the resilience — but electing a primary and
  promoting a replacement mid-draft is deliberately not built.
- **Any change to what the tap relays.** The frame contract is 010's.
- **Automatic enablement without user action.** The acknowledgement is the
  security property, not a UX nicety.
- **Cross-league or cross-season sharing.**
- **Closing 005's open items** (draft-end detection, keeper reconciliation).
- **009's operational concerns** — alerting that a session died belongs there;
  deciding what a session *is* belongs here.
