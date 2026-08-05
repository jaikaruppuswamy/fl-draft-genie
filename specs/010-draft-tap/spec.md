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

## Clarifications

### Session 2026-08-03

- Q: Should relayed messages carry leaguemates' names, or be stripped to numeric ids? → A: **Stripped to ids at the source.** The companion forwards player ids, team ids and pick positions only, discarding names, member identifiers and free text. Draft Genie resolves names from the owner's own authenticated league sync, so nothing is lost — and the tap stops being a route for other people's data at all. Recorded fixtures are then clean by construction rather than by a later scrubbing step.
- Q: Which browsers must the companion support? → A: **Desktop Chrome only.** One target, one test matrix, fastest fixes on a protocol that can break without warning. Live monitoring is therefore unavailable when drafting from an iPad, a phone, or ESPN's mobile app — a permanent, documented product limitation, which 005 already surfaces honestly rather than showing a stale board.
- Q: How should the companion be packaged and installed — userscript or Chrome extension? → A: **Userscript**, run under a script manager the owner installs once. Chosen for the update path, not the install: an undocumented protocol can break the morning of a draft, and a userscript is edit-and-reload in minutes where a store extension waits on review. (Chrome also blocks self-hosted extension installs outside developer mode, so that middle option is not viable.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Establish what ESPN actually sends (Priority: P1) 🚦 GATE

Before any relay is built, a real draft is observed and its messages are
decoded until every field's meaning is established from data — in particular
the field that identifies who made a pick, which public sources describe
inconsistently and which first-round data provably cannot disambiguate.

**Why this priority**: Constitution v1.1.0 requires a feature resting on
unverified external behaviour to verify it first, in the cheapest possible
experiment, before dependent code. 005's Gate 0 is the precedent: one evening's
capture disproved a data source that eight phases assumed. Here the risk is
narrower but the same shape — a relay built on a mis-read field would look
correct in round 1 and be wrong from round 2 onward, discovered on draft day.

**Independent Test**: Decode a capture spanning **at least three rounds** and
show that each field's claimed meaning holds for every pick — specifically that
the identifying field's value tracks the drafting team across the snake
reversal, which is the only place team id and pick number diverge.

**Acceptance Scenarios**:

1. **Given** a real draft has been observed, **When** the capture is decoded,
   **Then** every field the relay depends on has a meaning established from
   observed data, recorded in the message contract, with no field left
   "assumed".
2. **Given** the capture spans a round boundary, **When** the identifying field
   is checked against the known draft order, **Then** its meaning is
   unambiguous — the reversal distinguishes team id from pick number.
3. **Given** a field cannot be resolved from the capture, **When** the contract
   is written, **Then** it is recorded as unresolved and **no requirement is
   allowed to depend on it** until it is.

---

### User Story 2 - Picks reach Draft Genie as they happen (Priority: P2)

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

### User Story 3 - Install it once, without handling secrets (Priority: P3)

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

### User Story 4 - You can tell at a glance whether it is working (Priority: P4)

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

### User Story 5 - A recorded corpus that unblocks the rest of the roadmap (Priority: P5)

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
  sends is relayed with its meaning preserved (subject to FR-006a's field
  filtering — "as-is" never overrides the privacy rule); interpreting
  corrections belongs to the receiving
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
- **FR-003a**: Supported environment is **desktop Chrome** (ratified in
  clarification). The owner MUST be told plainly, before draft day, that
  drafting from a phone, an iPad, or ESPN's mobile app means no live
  monitoring — this is a product limitation, not a defect to work around.

**Relay**

- **FR-004**: The companion MUST relay draft-state messages to Draft Genie,
  preserving their original order and identifying the league they belong to.
- **FR-005**: The companion MUST relay the **complete set of picks**, decoded
  per FR-006c and distinguishable from an incremental message, on **every**
  occasion ESPN supplies one — at minimum on draft-room page load and on
  reconnect — and MUST relay it before any incremental message from that same
  session. 005 FR-012 makes this the source of truth for reconciliation, so
  "whenever ESPN provides one" is not discretionary: if the companion suppresses
  or defers it, 005's authority model has nothing to reconcile against.
- **FR-005a**: Every relayed pick MUST carry a **stable identity** that is the
  same across the incremental message and the complete set, so the receiving
  side can deduplicate (FR-010) and 005 can key its reconciliation. The identity
  MUST be a field whose meaning was established in US1 — it MUST NOT be the
  field US1 exists to disambiguate unless US1 resolved it.
- **FR-006**: The companion MUST relay only draft state. Chat messages,
  presence information, keep-alives, and anything else not describing the draft
  MUST be discarded and never transmitted (other managers' chat is not ours to
  collect).
- **FR-006a**: Relayed messages MUST carry **numeric identifiers, pick
  positions, and the browser-side observation time only** (ratified in
  clarification). Manager names, display names, team names, member identifiers
  and any free text MUST be discarded **before transmission**, not scrubbed
  afterwards. Draft Genie resolves names from the owner's own league sync, so
  nothing is lost. This makes the privacy property testable by inspection: a
  name appearing in a relayed message is a defect, and the leaguemates — who are
  not Draft Genie users and never agreed to anything — have no data crossing the
  boundary.
- **FR-006b**: The observation time is **explicitly in scope** and MUST be
  relayed with every message. It is not personal data, and it is load-bearing
  downstream: 005 FR-020a distinguishes a collapsed batch from a live sequence
  by whether events share an observation time, 008's replay lab needs per-pick
  timing, and both features' latency criteria are measured from it. A privacy
  filter that dropped it would silently break the contract this feature exists
  to serve.
- **FR-006c**: Filtering MUST be applied to **decoded content**, not to the wire
  form. Where ESPN sends an aggregate in an encoded or packed form (the full
  pick ledger is one), the companion MUST decode it, extract the permitted
  fields, and relay only those. Forwarding an encoded blob verbatim is
  forbidden: it would satisfy the letter of FR-005 while carrying exactly the
  identities FR-006a forbids, and would pass an inspection that cannot see
  inside it.
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
- **FR-014**: One install MUST serve all of the owner's connected leagues
  without per-league setup, and MUST identify on every message which league it
  belongs to. 005 FR-007d scopes an accepted frame to **one league connection**;
  this feature satisfies that by carrying the league on the message rather than
  by issuing one credential per league. The credential is per-user; the scoping
  is per-message. Both specs are then describing the same thing.
- **FR-014a**: The pairing credential's **lifetime and rotation MUST be
  defined**: it persists across drafts rather than being issued per draft, can
  be rotated by the owner without reinstalling the script, and expires on a
  stated schedule. Its blast radius if leaked MUST be limited to appending
  draft messages for that owner's leagues — never reading league data, never
  touching ESPN. An edge case already assumes it can expire mid-draft, so an
  undefined lifetime is a gap, not a plan detail.

**Honesty about its own state**

- **FR-015**: The companion MUST show whether it is paired, connected, and
  relaying, including how recently it last relayed something.
- **FR-015a**: The companion MUST report liveness **periodically and
  independently of pick traffic**, not only when its state changes. A tap that
  speaks only on change is silent exactly when it is healthy, which the receiver
  cannot distinguish from a tap that has died — and pick silence cannot settle
  it either, since observed gaps run from ~1 s between autodrafted picks to 90 s+
  between human ones. The report MUST include whether the tap's tab is
  **hidden**, because a background tab's timers are throttled to roughly one per
  minute (research §"Gotchas") and a receiver applying a single lapse threshold
  would declare a healthy backgrounded tap dead. The tap cannot defeat that
  throttling but is the only party able to observe it. Liveness MUST also be
  reported on wake events (`visibilitychange`, `pageshow`, `focus`, `online`),
  including the transition *into* hidden, for the same reason FR-008's flush is
  event-driven. Consumed by 005 FR-007c/FR-007e.
- **FR-016**: Each failure mode — not paired, Draft Genie unreachable, message
  format unrecognised, not a draft page — MUST be reported distinctly and in
  plain language, with what to do about it.
- **FR-017**: When ESPN's messages stop matching what the companion
  understands, it MUST report a compatibility problem **loudly**. Relaying
  nothing while appearing healthy is the one behaviour this feature must never
  exhibit.
- **FR-017a**: FR-006's silent discard and FR-017's loud report MUST be
  distinguished by an explicit rule, because an unknown message otherwise
  satisfies both: a message is discarded silently only if it matches a **known**
  non-draft kind (chat, presence, keep-alive). Anything **unrecognised** is
  reported under FR-017 and counted, never silently dropped. Without this rule
  an engineer can implement "discard what I don't understand" and produce
  exactly the silent degradation FR-017 forbids.

**Deliverables for the rest of the roadmap**

- **FR-018**: The message contract the companion produces MUST be documented
  and versioned, so 005 can be built and tested against it without a live
  draft.
- **FR-019**: A **full real draft MUST be captured** as an ordered recording
  and committed as a test fixture. Because FR-006a strips identities before
  transmission, the **relayed** recording is clean by construction — it contains
  only permitted fields and never held a name or member identifier to scrub. A
  verification step MUST still assert this before the fixture is committed;
  "clean by construction" is a design property, not a substitute for checking,
  and the check MUST run over decoded content (FR-006c).
- **FR-019a**: The **raw discovery capture** required by US1 is a different
  artifact and is **not** clean by construction — it is unstripped by necessity,
  since decoding it is how the field meanings are learned, and it can therefore
  contain the owner's own ESPN identifiers, leaguemates' member identifiers and
  names, and chat text. It MUST be treated as credentialed material: sanitized
  before it leaves the capture machine, **never committed in raw form**, and
  only its sanitized derivative may become a fixture. This is the same defect
  class that 005's fixture capture had to fix; it is stated here so it is not
  rediscovered a third time.
- **FR-019b**: The committed recording MUST be accompanied by an **independently
  derived expected pick sequence** — taken from ESPN's own post-draft record,
  not from the recording — so the offline replay check (SC-010) can actually
  fail. A recording validated only against itself proves nothing.
- **FR-020**: The recording MUST be sufficient to reproduce the draft's
  complete pick sequence offline.

**Install**

- **FR-021**: The companion MUST ship as a **userscript** run under a
  third-party script manager (ratified in clarification). Installation MUST be
  documented well enough that the owner can complete it unaided before draft
  day — including the one-time script-manager install — and MUST be verifiable:
  the owner can confirm it works without waiting for a real draft.
- **FR-022**: The companion MUST be replaceable **without waiting on any
  third-party review process**, and MUST report its own version alongside its
  status (FR-015) and on every relayed message, so Draft Genie can **reject or
  warn on** a version it does not understand rather than silently misreading it.
  A version number with no defined consequence is decoration.
- **FR-023**: The supported configuration MUST be named concretely — desktop
  Chrome plus a specific script manager, at stated minimum versions — so
  "supported" is checkable at install time rather than a matter of opinion.
- **FR-024**: The companion MUST detect that a draft has **finished** and stop
  relaying, reporting that it has done so. Where it cannot determine whether a
  draft is still running, it MUST report that uncertainty under FR-017 rather
  than going quiet — an idle companion and a dead one must never look the same. This is the reason the userscript form was chosen:
  ESPN can change the draft page at any time, including on draft day.

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

- **SC-000** *(gate — Constitution v1.1.0, Development Workflow)*: **No
  requirement that fixes a message's meaning — FR-004, FR-005, FR-005a, FR-006a
  — is implemented before US1's capture has established that meaning from
  observed data.** Evidenced by the message contract (FR-018) recording, per
  field, the capture it was derived from, with zero fields marked "assumed".
- **SC-001**: During a live draft, **100% of picks** are relayed — no pick is
  missing from Draft Genie at the end of a full draft, verified against ESPN's
  own post-draft record.
- **SC-002**: 95% of picks are **accepted by Draft Genie's ingest within 3
  seconds** of the companion observing them, and 100% within 10 seconds.
  Measured from the observation time the companion stamps (FR-006b) to the
  ingest acknowledgement, so both ends of the interval are recorded and no
  cross-machine clock comparison is required. This is deliberately **less** than
  005's SC-001 end-to-end budget of 5 s / 15 s: 005 needs the remainder for
  persisting, applying and pushing, and two specs claiming the same envelope
  would leave it none.
- **SC-003**: **Zero** messages are transmitted to ESPN across a full monitored
  draft, and no connection to ESPN is opened by the companion. Verified two
  ways, because a userscript's own traffic is not reliably attributable in the
  page's network panel: (a) by review of the shipped script, which contains no
  call that writes to an ESPN origin, and (b) by running a draft with all
  non-ESPN egress blocked except Draft Genie's ingest and confirming the draft
  proceeds unchanged and no additional ESPN request appears.
- **SC-004**: The owner's draft experience is unchanged: ESPN's interface
  behaves identically with the companion active, and no draft control is
  obstructed.
- **SC-005**: With Draft Genie unreachable for 60 seconds mid-draft, every pick
  made during the outage is delivered in order once it returns, with none lost.
- **SC-006**: A first-time install on a clean browser profile succeeds in under
  10 minutes following the written instructions, and the owner can confirm it is
  working without a live draft.
- **SC-007**: Across a full monitored draft, **no transmission** from the
  companion contains an ESPN cookie value, a manager or team name, a member
  identifier, or any free text — only numeric identifiers and pick positions.
  The same holds for the committed recording, verified before it is committed.
- **SC-008**: A revoked pairing stops relaying within one message, and the
  owner's ESPN draft is unaffected.
- **SC-009**: When fed messages it does not understand, the companion reports a
  compatibility problem in 100% of trials rather than appearing healthy.
- **SC-010**: The committed recording replays offline to the exact pick
  sequence of the draft it was captured from.
- **SC-011**: Relaying works across all of the owner's connected leagues from a
  single install, including two drafts running simultaneously, with every
  message identifying its league.
- **SC-012**: The owner is told, before draft day and without having to ask,
  that drafting from a phone, an iPad or ESPN's mobile app means no live
  monitoring (FR-003a) — verified by a first-time install walkthrough in which
  the limitation is encountered without searching for it.
- **SC-013**: With two draft-room tabs open for the same league, the relayed
  stream still yields exactly one instance of each pick downstream, and the
  ordering 005 replays from is reconstructible — each message identifies which
  install and tab produced it (FR-004, FR-010).
- **SC-014**: When the draft completes, the companion stops relaying within one
  message and reports the draft as finished; when it can no longer tell whether
  a draft is running, it reports that instead of falling silent (FR-017).
- **SC-015**: Every requirement in this spec is validated by at least one
  success criterion or acceptance scenario, checked at spec review rather than
  asserted.

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
- **Delivery form** *(ratified in clarification)*: a **userscript** under a
  third-party script manager. The deciding factor was the update path — an
  undocumented protocol can break on draft day, and a store-reviewed extension
  cannot be fixed in time. Accepted costs: the owner installs a script manager
  first, and that manager is itself third-party software in the trust chain.
- **Browser support** *(ratified in clarification)*: **desktop Chrome only**.
  One target keeps the test matrix small, which matters because every future
  ESPN change reopens it. Firefox and Safari are out of scope, not deferred.
  The consequence is explicit and permanent: **drafting from an iPad, a phone,
  or ESPN's mobile app has no live monitoring**, and the product says so rather
  than degrading quietly.
- **Receiving side belongs to 005**: the ingest endpoint's server behaviour,
  session state, reconciliation, event emission and storage are 005's scope.
  This feature owns the browser side and the message contract between them.
- **Constitution v1.1.0 permits exactly one such companion**, strictly passive,
  with the web app fully usable without it. This feature must not become a
  second app: it observes and relays, and does nothing else.
- **No recommendations, no draft UI here** — 006 and 007 own those. A user with
  this feature and nothing else has picks flowing into Draft Genie, which is
  exactly enough to unblock the rest.
