# Feature Specification: Draft Monitor

**Feature Branch**: `005-draft-monitor`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "005" (ROADMAP.md feature 005 — draft-monitor: the real-time nerve center that detects the draft room opening, pulls the draft order, follows every pick, maintains authoritative draft state, recovers from crashes, and pushes updates to connected clients)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Follow a live draft pick by pick (Priority: P1)

The owner's draft is underway in ESPN. In Draft Genie, the league's draft view
shows every pick as it lands — round, overall pick number, which team picked,
which player — plus who is on the clock right now, each team's roster so far,
and how many picks remain until the owner's next turn. Nothing needs to be
refreshed or clicked; the view keeps up with the room.

**Why this priority**: This is the feature. Without an accurate live picture of
the draft, no recommendation (006) can be computed and no draft-room screen
(007) has anything to show. It is also independently valuable on its own: a
live "what's gone, what's left, when am I up" board beats tabbing between ESPN
and a spreadsheet.

**Independent Test**: Point a draft session at a draft in progress (a real
ESPN draft or a recorded pick feed) and confirm the pick list, rosters,
on-the-clock team, and picks-until-my-turn match ESPN throughout, updating
without user action.

**Acceptance Scenarios**:

1. **Given** a supported league whose draft is in progress, **When** a pick is
   made in ESPN, **Then** that pick appears in Draft Genie within seconds with
   its round, overall pick number, drafting team, and player — and the
   drafted player disappears from the available pool.
2. **Given** a live draft, **When** the turn advances, **Then** the on-the-clock
   team and the picks-until-my-turn count update accordingly.
3. **Given** a live draft, **When** the owner's own pick is made in ESPN,
   **Then** it appears on the owner's roster and picks-until-my-turn resets to
   the owner's next turn in the order.
4. **Given** a keeper league where some players were rostered before the
   draft, **When** the draft view opens, **Then** those players are already
   shown as unavailable and attributed to the rostering team.
5. **Given** the final pick of the draft is made, **When** the state updates,
   **Then** the draft is marked complete, the final rosters are retained, and
   Draft Genie stops polling ESPN for that draft.

---

### User Story 2 - Survive reloads, disconnects, and crashes (Priority: P2)

Mid-draft the owner reloads the page, loses Wi-Fi for a minute, or switches
from laptop to iPad. Draft Genie comes back with the complete, correct draft
state — every pick so far, current rosters, whose turn it is — not a partial
or empty board. The same holds if Draft Genie's own draft session is lost
(deploy, crash, restart): it rebuilds the entire draft from ESPN.

**Why this priority**: Constitution V — a live draft cannot be paused or
replayed. A monitor that is correct only while nothing goes wrong is not
usable on draft day. Recovery is also the same code path as joining a draft
that started before Draft Genie was opened, so it earns its priority twice.

**Independent Test**: During a draft in progress, reload the client, kill the
server-side session, and disconnect the network in turn; each time, confirm
the restored state matches ESPN exactly (same picks, same rosters, same team
on the clock).

**Acceptance Scenarios**:

1. **Given** a live draft with picks already made, **When** the client page is
   reloaded, **Then** the full state (all picks, rosters, on-the-clock,
   picks-until-my-turn) is restored within a few seconds without user action.
2. **Given** a live draft, **When** Draft Genie's draft session is destroyed
   and restarted, **Then** it rebuilds complete state from ESPN alone and the
   rebuilt state is identical to the pre-crash state.
3. **Given** a draft that started before the owner opened Draft Genie, **When**
   the draft view is opened, **Then** the complete pick history to date is
   present, not just picks made after opening.
4. **Given** ESPN is unreachable or erroring, **When** the owner is watching,
   **Then** the last known state keeps serving, is visibly marked as
   not-currently-updating with its age, and updating resumes automatically
   once ESPN responds again — with any picks missed during the outage filled
   in.
5. **Given** ESPN reports a correction (a pick undone, re-made, or reordered
   by the commissioner), **When** the next read happens, **Then** Draft Genie
   reconciles to ESPN's version without duplicated or phantom picks.

---

### User Story 3 - The session arms itself before the draft (Priority: P3)

Draft day: the owner does not have to remember to start anything. For a
connected league with a scheduled draft, Draft Genie arms a draft session in
the pre-draft window, notices when the draft room opens, and captures the
draft order the moment ESPN publishes it (typically about an hour before the
start) — showing the full order and the owner's slot, then flipping to live
tracking on its own when picking begins.

**Why this priority**: Valuable but not load-bearing — the owner can open the
draft view manually (US1 covers on-demand start). Automatic arming removes a
draft-day failure mode and gets the order on screen for pre-draft planning.
It also extends machinery 001 already runs (the pre-draft re-sync window).

**Independent Test**: With a league whose draft time is in the near future and
order not yet published, let the pre-draft window elapse against a simulated
ESPN; confirm the session arms, the order appears as soon as it is published,
and the session flips to live when ESPN reports the draft in progress.

**Acceptance Scenarios**:

1. **Given** a connected league with a supported draft scheduled, **When** the
   pre-draft window is entered, **Then** a draft session for that league is
   armed and reports its status (armed, order pending) without the owner
   opening anything.
2. **Given** an armed session, **When** ESPN publishes the draft order,
   **Then** the full order and the owner's draft slot become visible within
   one polling cycle.
3. **Given** an armed session, **When** ESPN reports the draft has started,
   **Then** the session transitions to live tracking and begins following
   picks with no user action.
4. **Given** a league whose draft type is not supported (e.g. auction or an
   offline draft), **When** its draft time arrives, **Then** Draft Genie shows
   a clear "live monitoring not supported for this draft type" state and does
   not open a session — the league remains fully usable elsewhere in the app.

---

### User Story 4 - Events the engine and UI can build on (Priority: P4)

Every meaningful change in the draft is published as an ordered event stream —
`pick_made`, `on_deck`, `on_the_clock`, `draft_complete` — that other parts of
Draft Genie subscribe to. `on_deck` fires with enough lead time that a
recommendation can be computed *before* the owner is on the clock, not after.

**Why this priority**: This is the contract features 006 and 007 are built
against, and it is what makes Principle V's pre-computation possible. It has
little standalone UI, so it ranks last as a slice — but the shape must be
right now, because two downstream features depend on it.

**Independent Test**: Replay a pick sequence against a session and record the
emitted events: each pick yields exactly one `pick_made`, the owner's turns
each yield one `on_deck` followed by one `on_the_clock`, and the last pick
yields one `draft_complete` — all in draft order.

**Acceptance Scenarios**:

1. **Given** a live draft, **When** each pick is observed, **Then** exactly one
   `pick_made` event is emitted for it, in draft order, carrying the pick and
   the resulting draft state summary.
2. **Given** the owner's turn approaches, **When** the owner is two picks away,
   **Then** `on_deck` is emitted once; **When** the owner is on the clock,
   **Then** `on_the_clock` is emitted once.
3. **Given** the draft ends, **When** the final pick is observed, **Then**
   `draft_complete` is emitted exactly once and no further events follow.
4. **Given** a subscriber connects mid-draft, **When** it attaches, **Then** it
   first receives a complete state snapshot and only then incremental events —
   with no gap and no replayed duplicates between the two.

---

### Edge Cases

- **Draft order never published or published late**: picks are still tracked
  from ESPN's reported pick sequence; picks-until-my-turn is reported as
  unknown rather than guessed, and becomes available the moment the order is.
- **Order deviates from the snake formula** (traded picks, commissioner
  edits): ESPN's reported pick sequence is authoritative over any computed
  snake order; the computed order is only a fallback for looking ahead.
- **Autodrafted picks**: indistinguishable from manual picks and treated as
  normal picks — no special handling.
- **Keepers / pre-draft rostered players**: counted as unavailable and
  attributed to their team before pick one; never double-counted if ESPN also
  reports them among the draft picks.
- **Commissioner pauses or reverses a pick**: state reconciles to ESPN's
  current truth on the next read; already-emitted events are not retracted but
  the corrected state is republished.
- **Two of the owner's leagues drafting at the same time**: each league has its
  own independent session and state; neither degrades the other.
- **Several tabs or devices watching one draft**: all receive the same stream
  and converge on the same state.
- **A user who is not the connection's owner attempts to subscribe**: refused —
  draft state is per-user isolated like every other league resource.
- **Draft time passes with no draft** (postponed/rescheduled): the armed
  session times out quietly and re-arms if a new draft time is published;
  it does not poll indefinitely.
- **ESPN credentials expired at draft time**: the session surfaces a
  credential problem distinctly from an ESPN outage, because the fixes differ.
- **Draft already complete when first opened**: the final state is shown as
  complete; no polling starts.

## Requirements *(mandatory)*

### Functional Requirements

**Session lifecycle**

- **FR-001**: The system MUST maintain a draft session per connected league
  (per season) that owns that league's authoritative draft state.
- **FR-002**: A session MUST be able to start on demand when the owner opens
  the league's draft view, and MUST also arm automatically for leagues with a
  scheduled, supported draft during the pre-draft window already scanned in
  001.
- **FR-003**: A session MUST detect that the draft room has opened / the draft
  has started from ESPN and transition from pre-draft to live tracking with no
  user action.
- **FR-004**: A session MUST capture the draft order as soon as ESPN publishes
  it (typically ~1 hour pre-draft), including the owner's slot, and MUST
  report the order as unknown — never fabricated — before then.
- **FR-005**: A session MUST mark the draft complete when ESPN reports it
  complete or all picks are accounted for, retain the final state, and stop
  polling.
- **FR-006**: For leagues whose draft type is not supported for live
  monitoring, the system MUST expose an explicit unsupported state and MUST
  NOT open a session.

**Following the draft**

- **FR-007**: While a draft is live, the system MUST observe ESPN frequently
  enough that a completed pick is reflected in draft state within 5 seconds of
  ESPN reporting it, and MUST tighten its cadence as the owner's turn
  approaches.
- **FR-008**: Observation MUST stay respectful of ESPN: a bounded, documented
  maximum request rate per league, exponential back-off on errors, no polling
  while a session is idle/armed beyond a slow heartbeat, and no polling at all
  once the draft is complete.
- **FR-009**: The system MUST be strictly read-only against ESPN — it never
  submits a pick, sets autodraft, or writes any draft data (Constitution VI).

**Authoritative state**

- **FR-010**: Draft state MUST include: every pick made (overall pick number,
  round, pick-in-round, drafting team, player), each team's roster so far, the
  team currently on the clock, the owner's next pick number, picks until the
  owner's turn, and the set of players still available.
- **FR-011**: The available-player set MUST be the league's player board (002)
  minus everyone drafted and minus pre-draft rostered/keeper players.
- **FR-012**: ESPN MUST be the source of truth: on every read, state reconciles
  to ESPN's reported picks, tolerating corrections, undos, and reordering
  without producing duplicate or phantom picks.
- **FR-013**: Draft state MUST be durable — it survives process restarts and
  redeploys without requiring a full rebuild, and remains queryable after the
  draft completes.
- **FR-014**: The system MUST be able to rebuild complete draft state from
  ESPN alone, with no reliance on previously stored state, and the rebuilt
  state MUST be identical to state built incrementally from the same draft.

**Real-time delivery**

- **FR-015**: Connected clients MUST receive draft state changes pushed to
  them in real time, without the client polling the app.
- **FR-016**: A connecting or reconnecting client MUST receive a complete
  state snapshot first, then incremental updates, with no missed or duplicated
  changes across the hand-off.
- **FR-017**: Clients MUST reconnect automatically after a dropped connection
  and converge on current state; multiple clients on one draft MUST all show
  the same state.
- **FR-018**: Only the authenticated owner of the league connection MUST be
  able to subscribe to that draft's state (per-user isolation).

**Events**

- **FR-019**: The system MUST emit an ordered event stream containing at least
  `pick_made`, `on_deck`, `on_the_clock`, and `draft_complete`, each occurrence
  emitted exactly once and carrying enough context for a consumer to act
  without re-reading ESPN.
- **FR-020**: `on_deck` MUST fire while the owner is still two picks away from
  their turn, so a recommendation can be pre-computed before `on_the_clock`
  (Constitution V).
- **FR-021**: The event contract MUST be consumable by an offline/replayed
  pick sequence, so downstream features (006, 008) can be tested without a
  live draft.

**Degradation & visibility**

- **FR-022**: When ESPN is unavailable, the last known state MUST keep serving,
  marked as not-currently-updating with its age, and MUST resume automatically
  — backfilling picks missed during the outage — when ESPN recovers.
- **FR-023**: Credential failures MUST be surfaced distinctly from ESPN
  outages, with a path to re-enter credentials.
- **FR-024**: Session lifecycle transitions and failures (armed, live,
  degraded, rebuilt, complete, aborted) MUST be observable in logs/state for
  draft-day diagnosis, and MUST never include ESPN cookies or other secrets.
- **FR-025**: The app MUST provide a minimal draft status surface for a
  connected league — session status, pick feed, on-the-clock, picks until the
  owner's turn — sufficient to validate this feature; the full draft-room
  experience remains 007's scope.

### Key Entities

- **Draft Session** *(per league connection, per season)*: status (unsupported,
  idle, armed, live, degraded, complete), draft type, scheduled time, draft
  order (or unknown), the owner's slot, last successful ESPN read time, and the
  current pick pointer.
- **Draft Pick**: overall pick number, round, pick-in-round, drafting team,
  player reference, and observed-at time. Ordered by overall pick number; the
  full set is the draft's history.
- **Team Draft Roster**: an ESPN team's picks so far in this draft, including
  pre-draft keeper/rostered players.
- **Draft Event**: kind (`pick_made`, `on_deck`, `on_the_clock`,
  `draft_complete`), monotonic sequence number, payload, and occurred-at —
  the ordered stream clients and the engine consume.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During a live draft, at least 95% of picks are reflected in
  Draft Genie's state within 5 seconds of ESPN reporting them, and 100% within
  15 seconds.
- **SC-002**: A connected client sees a state change within 1 second of the
  session recording it.
- **SC-003**: `on_deck` precedes `on_the_clock` for 100% of the owner's turns,
  with at least one full pick of lead time.
- **SC-004**: Reloading the client mid-draft restores complete, correct state
  in under 3 seconds, with zero missing picks.
- **SC-005**: Destroying the session mid-draft and rebuilding from ESPN
  reproduces identical draft state (same picks, rosters, on-the-clock team,
  available set) in under 10 seconds for a full 12-team, 16-round draft.
- **SC-006**: Joining a draft already in progress yields 100% of prior picks.
- **SC-007**: With ESPN unavailable for 60 seconds mid-draft, no state is lost,
  the staleness age is shown, and every pick made during the outage is present
  within one polling cycle of recovery.
- **SC-008**: Zero write requests are issued to ESPN across a full monitored
  draft, and per-league request volume stays within the documented rate bound.
- **SC-009**: Two leagues drafting concurrently each maintain complete and
  correct state, with no cross-contamination of picks or events.
- **SC-010**: A full recorded draft replayed through the session produces the
  exact expected event sequence — one `pick_made` per pick in order, paired
  `on_deck`/`on_the_clock` per owner turn, one terminal `draft_complete`.
- **SC-011**: The monitor is validated end-to-end against at least one real
  ESPN draft (or a full captured pick feed from one) before draft day.

## Assumptions

- **Snake drafts in v1**: 001 already flags a league's draft as supported only
  when ESPN reports a snake draft. Auction drafts (a different state model:
  budgets and nominations) and offline drafts are out of scope here and
  surface as unsupported; revisiting is a later spec. *(ROADMAP open question —
  confirm in `/speckit-clarify`.)*
- **Polling is the mechanism**: ESPN offers no push API for drafts
  (constitution), so cadence and back-off are the levers. The concrete
  intervals — baseline while live, tightened near the owner's turn, heartbeat
  while armed — are set in the plan against FR-007/FR-008's bounds.
  *(ROADMAP open question — confirm in `/speckit-clarify`.)*
- **Real-time transport is already ratified**: 001 ratified WebSocket push with
  a per-draft-room coordination point; this feature assumes that direction and
  the plan fixes the details.
- **Draft data comes from ESPN views 001 already uses** (league settings for
  the order and draft type, draft detail for picks) through the existing single
  read-only ESPN module, using the connection's stored credentials.
- **The owner's team is known**: 001 guarantees every connection identifies the
  user's team, which is what makes "picks until my turn" meaningful.
- **Player identity comes from 002**: picks resolve against the existing global
  player universe; a pick of a player missing from the board is recorded by
  ESPN identity and shown as unresolved rather than dropped.
- **Out of scope**: recommendations (006), the designed draft-room UI (007),
  and replay/import/simulation tooling (008). This feature ships the state,
  the events, and a minimal status surface — 008 will build on the durable
  state this feature already keeps, and no separate recording pipeline is built
  here.
- **Draft-day environment**: the owner watches on one device at a time
  (occasionally two), on ordinary consumer broadband/Wi-Fi, with the ESPN draft
  room open in parallel — Draft Genie never replaces ESPN's own interface.
