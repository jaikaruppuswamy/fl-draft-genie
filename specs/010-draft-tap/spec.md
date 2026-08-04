# Feature Specification: Draft Tap

**Feature Branch**: `010-draft-tap`

**Created**: 2026-08-03

**Status**: Draft

**Input**: User description: "010" (ROADMAP.md feature 010 — draft-tap: the browser companion that passively relays live draft picks from the user's own ESPN draft-room tab to Draft Genie, because ESPN's read API cannot see a draft in progress)

## Why This Feature Exists

Feature 005's Gate 0 established empirically that **ESPN writes a draft to its
league database once, when the draft completes**. Across 207 samples spanning
~30 real picks in a live snake draft, the read API never reported a single
pick. No polling cadence can fix that.

The picks do exist in one place while the draft is running: the realtime
channel the user's **own draft-room tab is already receiving**. This feature
relays those messages to Draft Genie. It is the only thing standing between
Draft Genie and being a pre-draft tool, and 005 is blocked until it lands.

Constitution v1.1.0 permits exactly one optional browser companion for this
purpose, and requires it to be strictly passive: observation must never become
participation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Picks reach Draft Genie as they happen (Priority: P1)

The owner is drafting in ESPN as usual. With the companion installed, every
pick anyone makes shows up in Draft Genie within a couple of seconds —
including on a second device, so the laptop drafts and the iPad advises.
Nothing about the ESPN draft room looks or behaves differently.

**Why this priority**: This is the entire feature, and the only path to a live
draft assistant. Without it 005, 006 and 007 have no data.

**Independent Test**: Run a draft in the test league with the companion
installed and Draft Genie's diagnostic view open on another device; confirm
every pick appears there within seconds, in the right order, with the right
player and team.

**Acceptance Scenarios**:

1. **Given** the companion is installed and paired, **When** any manager makes
   a pick in the ESPN draft room, **Then** that pick reaches Draft Genie within
   seconds, identifying the player, the drafting team, and the pick's position
   in the draft.
2. **Given** a draft in progress, **When** the owner reloads the ESPN draft
   room, **Then** the complete set of picks so far is re-sent, so Draft Genie
   can reconcile rather than assume it missed nothing.
3. **Given** the companion is running, **When** the owner inspects the ESPN
   draft room, **Then** nothing about ESPN's own interface is altered,
   obstructed or slowed.
4. **Given** the draft finishes, **When** the final pick is relayed, **Then**
   the companion stops relaying and says so.

---

### User Story 2 - Install it once, without handling secrets (Priority: P2)

Before draft day the owner installs the companion and links it to their Draft
Genie account. The linking step never asks for ESPN credentials, and the
companion never sends ESPN cookies to Draft Genie. If the owner later wants to
revoke it, they can, without touching their ESPN account.

**Why this priority**: A relay nobody can install is worthless, and this is the
step where a careless design would start moving ESPN secrets around. It ranks
below P1 only because P1 defines what "working" means.

**Independent Test**: From a clean browser profile, follow the documented
install steps and confirm the companion pairs with the account and begins
relaying — with no ESPN credential entered anywhere, and none present in
anything it transmits.

**Acceptance Scenarios**:

1. **Given** a fresh browser, **When** the owner follows the install
   instructions, **Then** the companion is active on ESPN draft-room pages and
   paired to their Draft Genie account.
2. **Given** the companion is paired, **When** its transmissions are inspected,
   **Then** they contain no ESPN cookie value and no ESPN password.
3. **Given** the owner revokes the pairing in Draft Genie, **When** the
   companion next tries to relay, **Then** it is refused and reports that it
   needs re-pairing; the owner's ESPN account is unaffected.
4. **Given** the owner is connected to several leagues, **When** they draft in
   any of them, **Then** the companion relays to the right league's session
   without per-league setup.

---

### User Story 3 - You can tell at a glance whether it is working (Priority: P3)

The companion shows whether it is connected, paired and relaying. If it stops
working — the pairing lapsed, Draft Genie is unreachable, or ESPN changed their
page — the owner finds out immediately, in plain language, not by noticing that
Draft Genie's board looks wrong.

**Why this priority**: A silently dead relay is worse than no relay: Draft
Genie would show a confident, stale board. 005 detects the absence of frames
server-side, but the owner needs to see the cause where they can fix it.

**Independent Test**: Break each condition in turn — revoke the pairing, block
Draft Genie's endpoint, feed the companion an unrecognisable message — and
confirm each surfaces a distinct, accurate, actionable status.

**Acceptance Scenarios**:

1. **Given** the companion is relaying normally, **When** the owner looks at
   the ESPN draft-room tab, **Then** an unobtrusive indicator shows it is
   connected and how recently it relayed something.
2. **Given** Draft Genie is unreachable, **When** picks are made, **Then** the
   companion buffers them, shows a distinct "not reaching Draft Genie" state,
   and delivers the buffered picks in order once the connection returns.
3. **Given** ESPN's messages no longer match what the companion understands,
   **When** that is detected, **Then** it reports a version/compatibility
   problem loudly rather than silently relaying nothing.

---

### User Story 4 - A recorded corpus that unblocks the rest of the roadmap (Priority: P4)

A full real draft is captured as an ordered, sanitized recording. That
recording is what lets 005's reconciler, 006's engine and 008's replay lab be
built and tested without needing a live draft.

**Why this priority**: No user ever sees it, but it is the deliverable that
converts "we think we know the message format" into something testable. It is
last only because it falls out of doing P1 properly.

**Independent Test**: Replay the recording offline and confirm it yields the
same complete pick sequence the draft actually had, with no real names or
identifiers in the file.

**Acceptance Scenarios**:

1. **Given** a full draft has been captured, **When** the recording is
   replayed, **Then** it reproduces every pick in order with player, team and
   position.
2. **Given** the recording is committed, **When** it is inspected, **Then** it
   contains no ESPN credential, no real manager name, and no real member
   identifier.

---

### Edge Cases

- **Owner drafts on a device the companion cannot run on** (phone, iPad, ESPN's
  mobile app): the companion simply is not there. 005 already reports "not
  receiving picks" rather than showing an empty board, and this feature does
  not attempt to work around it.
- **The ESPN draft-room tab is closed mid-draft**: relaying stops. Reopening it
  re-sends the full pick set, so Draft Genie recovers rather than resuming
  blind.
- **Two draft-room tabs open for the same league**: duplicate relays must not
  produce duplicate picks — the receiving side deduplicates on the pick's own
  identity, and the companion does not need to coordinate between tabs.
- **The owner is in two drafts at once**: each draft-room tab relays for its own
  league; neither contaminates the other.
- **Machine sleeps mid-draft**: on wake, the companion re-establishes and
  re-sends the full pick set rather than assuming its buffer is still valid.
- **ESPN changes the draft page or its message format**: the companion detects
  that it no longer understands what it is seeing and says so. Silent
  degradation is the failure mode this must never have.
- **A message arrives that is not draft state** (chat, presence, keep-alives):
  it is discarded and never transmitted.
- **Draft is paused or a pick is reversed by the commissioner**: whatever ESPN
  sends is relayed as-is; interpreting corrections belongs to the receiving
  side (005 FR-012), not here.
- **Pairing expires mid-draft**: the companion buffers, surfaces the problem,
  and delivers on re-pair — it never discards picks it has already seen.

## Requirements *(mandatory)*

### Functional Requirements

**Passivity — the constitutional boundary**

- **FR-001**: The companion MUST be strictly passive with respect to ESPN. It
  MUST NOT open any connection to ESPN, MUST NOT transmit anything to ESPN,
  MUST NOT join or register as a draft participant, and MUST operate only by
  observing messages the user's own browser session is already receiving
  (Constitution VI).
- **FR-002**: The companion MUST NOT alter, obstruct, or slow ESPN's draft
  interface. Any status it displays MUST be unobtrusive and MUST never overlay
  or intercept a draft control.
- **FR-003**: The companion MUST be active only on ESPN draft-room pages, and
  inert everywhere else.

**Relay**

- **FR-004**: The companion MUST relay draft-state messages to Draft Genie,
  preserving their original order and identifying the league they belong to.
- **FR-005**: The companion MUST relay the **complete set of picks** whenever
  ESPN provides one (page load, reconnect), so the receiving side can reconcile
  against an authoritative view rather than trusting an incremental stream
  indefinitely.
- **FR-006**: The companion MUST relay only draft state. Chat messages,
  presence information, keep-alives, and anything else not describing the draft
  MUST be discarded and never transmitted (other managers' chat is not ours to
  collect).
- **FR-007**: Relayed messages MUST reach Draft Genie fast enough to be useful
  while the owner is on the clock, and the companion MUST NOT batch so
  aggressively that it becomes the dominant source of delay.

**Reliability**

- **FR-008**: When Draft Genie is unreachable, the companion MUST buffer what
  it has seen and deliver it in order once contact is restored. It MUST NOT
  discard observed picks.
- **FR-009**: The companion MUST tolerate the tab being reloaded, the machine
  sleeping, and brief network loss, recovering by re-sending the complete pick
  set rather than assuming continuity.
- **FR-010**: Duplicate delivery MUST be safe: the same pick relayed twice MUST
  NOT produce two picks downstream. The companion MAY relay duplicates; the
  receiving side is responsible for identity.

**Pairing & secrets**

- **FR-011**: The companion MUST authenticate to Draft Genie as a specific
  user, using a credential that is **revocable**, **distinct from the ESPN
  cookie pair**, and that grants nothing beyond relaying draft messages for
  that user's own leagues.
- **FR-012**: The companion MUST NOT read, store, or transmit ESPN credentials.
  Pairing MUST NOT ask the owner for any ESPN secret.
- **FR-013**: Revoking the pairing in Draft Genie MUST stop the companion from
  relaying, without affecting the owner's ESPN account or draft.
- **FR-014**: One install MUST serve all of the owner's connected leagues,
  without per-league setup.

**Honesty about its own state**

- **FR-015**: The companion MUST show whether it is paired, connected, and
  relaying, including how recently it last relayed something.
- **FR-016**: Each failure mode — not paired, Draft Genie unreachable, message
  format unrecognised, not a draft page — MUST be reported distinctly and in
  plain language, with what to do about it.
- **FR-017**: When ESPN's messages stop matching what the companion
  understands, it MUST report a compatibility problem **loudly**. Relaying
  nothing while appearing healthy is the one behaviour this feature must never
  exhibit.

**Deliverables for the rest of the roadmap**

- **FR-018**: The message contract the companion produces MUST be documented
  and versioned, so 005 can be built and tested against it without a live
  draft.
- **FR-019**: A **full real draft MUST be captured** as an ordered recording
  and committed as a test fixture, sanitized so it contains no ESPN credential,
  no real manager name, and no real member identifier — using the same
  derivation the existing fixture tooling applies.
- **FR-020**: The recording MUST be sufficient to reproduce the draft's
  complete pick sequence offline.

**Install**

- **FR-021**: Installation MUST be documented well enough that the owner can
  complete it unaided before draft day, and MUST be verifiable — the owner can
  confirm it works without waiting for a real draft.

### Key Entities

- **Draft Message**: one observed unit of draft state — its kind, the league it
  belongs to, its position in the observed order, its payload, and when it was
  seen.
- **Pairing**: the link between one browser install and one Draft Genie
  account: a revocable credential, when it was issued, and when it was last
  used. Never contains ESPN credentials.
- **Draft Recording**: an ordered, sanitized capture of a complete draft's
  messages, committed as a fixture and replayable offline.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During a live draft, **100% of picks** are relayed — no pick is
  missing from Draft Genie at the end of a full draft, verified against ESPN's
  own post-draft record.
- **SC-002**: 95% of picks reach Draft Genie within **5 seconds** of appearing
  in the owner's draft room, and 100% within 15 seconds.
- **SC-003**: **Zero** messages are transmitted to ESPN across a full monitored
  draft, and no connection to ESPN is opened by the companion — verified by
  inspecting its network activity.
- **SC-004**: The owner's draft experience is unchanged: ESPN's interface
  behaves identically with the companion active, and no draft control is
  obstructed.
- **SC-005**: With Draft Genie unreachable for 60 seconds mid-draft, every pick
  made during the outage is delivered in order once it returns, with none lost.
- **SC-006**: A first-time install on a clean browser profile succeeds in under
  10 minutes following the written instructions, and the owner can confirm it is
  working without a live draft.
- **SC-007**: No transmission from the companion contains an ESPN cookie value,
  and no committed recording contains a real manager name or member identifier.
- **SC-008**: A revoked pairing stops relaying within one message, and the
  owner's ESPN draft is unaffected.
- **SC-009**: When fed messages it does not understand, the companion reports a
  compatibility problem in 100% of trials rather than appearing healthy.
- **SC-010**: The committed recording replays offline to the exact pick
  sequence of the draft it was captured from.
- **SC-011**: Relaying works across all of the owner's connected leagues from a
  single install, including two drafts running simultaneously.

## Assumptions

- **The premise is verified first.** Constitution v1.1.0's Development Workflow
  requires a feature resting on unverified external behaviour to test it in the
  cheapest possible experiment before dependent code. Here that means capturing
  real messages from a real draft **before** building the relay — the same
  discipline that made 005's Gate 0 cheap instead of catastrophic. The test
  league used for 005's Gate 0 is available and resettable.
- **The message format is not yet fully understood.** Third-party captures give
  a shape, but at least one field is genuinely ambiguous — a public protocol
  document and its own source code disagree on whether a key field is the team
  or the pick number, and first-round data cannot distinguish them. The capture
  must settle it; nothing downstream may assume it.
- **Delivery form** *(ROADMAP open question — confirm in `/speckit-clarify`)*: a
  userscript is assumed, since it needs no store review and can be installed
  from a file. A packaged extension is the alternative, with a friendlier
  install and a slower update path.
- **Browser support** *(ROADMAP open question — confirm in `/speckit-clarify`)*:
  desktop Chrome is assumed as the only supported target, because that is where
  the owner drafts. Firefox and Safari are not ruled out but are not promised.
- **Receiving side belongs to 005**: the ingest endpoint's server behaviour,
  session state, reconciliation, event emission and storage are 005's scope.
  This feature owns the browser side and the message contract between them.
- **Constitution v1.1.0 permits exactly one such companion**, strictly passive,
  with the web app fully usable without it. This feature must not become a
  second app: it observes and relays, and does nothing else.
- **No recommendations, no draft UI here** — 006 and 007 own those. A user with
  this feature and nothing else has picks flowing into Draft Genie, which is
  exactly enough to unblock the rest.
