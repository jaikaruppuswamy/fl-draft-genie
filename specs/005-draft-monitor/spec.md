# Feature Specification: Draft Monitor

**Feature Branch**: `005-draft-monitor`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "005" (ROADMAP.md feature 005 — draft-monitor: the real-time nerve center that detects the draft room opening, pulls the draft order, follows every pick, maintains authoritative draft state, recovers from crashes, and pushes updates to connected clients)

## Clarifications

### Session 2026-08-02

- Q: How often should Draft Genie check ESPN for new picks while a draft is live? → A: Two-tier adaptive — 10 s baseline, tightening to 3 s when the owner is within 3 picks of their turn.
- Q: Should the server keep watching ESPN while a draft is live but no client is connected? → A: Hybrid — the session stays alive for the whole draft, polling at a slow 30 s cadence while unattended and returning to the 10 s / 3 s tiers as soon as a client connects.
- Q: Which ESPN draft formats should live monitoring support this season? → A: Snake only, but with the state model and event contract shaped so a second format (auction) can be added later without reworking existing consumers — shape only, no auction implementation.
- Q: What should be visible in the app when this ships, given 007 owns the designed draft room? → A: A deliberately plain per-league diagnostic page (session status, live pick feed, on-the-clock, picks-until-your-turn, staleness age) — explicitly throwaway scaffolding that 007 replaces wholesale, not styled to the design system.
- Q: How long should a completed draft's full pick-by-pick record be kept? → A: Indefinitely, as season history — matching 002's retention of every season's projection sets, so 008's replay lab inherits a real corpus.

### Session 2026-08-02 (round 2, after `/speckit-analyze`)

- Q: `on_deck` cannot fire two picks ahead at snake round boundaries, where the owner picks back-to-back — what should the spec promise? → A: An ordinal guarantee — `on_deck` fires as early as the draft's structure allows, at most two picks ahead, always exactly once and always before `on_the_clock`, carrying the real `picks_until` (2, 1, or 0). 006 pre-computes its second pick off `on_the_clock(T)`.
- Q: "Exactly once" contradicts the correction path, which replays turn events after a reversed pick — which wins? → A: Exactly-once is scoped **per revision**. Every event carries the revision it was emitted under; a correction bumps the revision and replays the affected turns under the new number. Consumers dedupe on (revision, kind, overall) and treat a bump as "rewind and re-apply".
- Q: Should SC-001 keep promising 100% of picks within 12 s when the platform's timer can be delayed up to a minute during failover? → A: No — 95th percentile at the tier bound (12 s baseline, 4 s near the owner's turn, 35 s unattended), with a hard ceiling for 100% of **the tier bound plus the documented 60 s failover delay**. A flat 60 s ceiling was refined to tier+60 s because the delay lands on top of the polling interval, not instead of it.

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
  With the order unknown, "within 3 picks of the owner's turn" cannot be
  evaluated, so the cadence stays at its 10-second baseline (FR-007).
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
- **Laptop sleeps or every tab closes mid-draft**: the session stays alive at
  its unattended 30-second cadence, so reconnecting later serves a current
  snapshot immediately instead of triggering a full rebuild.
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

- **FR-001**: The system MUST maintain a draft session per **league
  connection** (one user's connection to one ESPN league) per season, which
  owns that connection's authoritative draft state. Two users connected to the
  same ESPN league have separate sessions and never share state.
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
- **FR-006**: Live monitoring MUST support snake drafts this season. For
  leagues whose draft type is not supported (auction, offline), the system
  MUST expose an explicit unsupported state and MUST NOT open a session.
- **FR-006a**: The draft **format MUST be an explicit attribute** of session
  state and of every recorded pick (ratified in clarification), and
  format-specific concepts MUST NOT leak into the shared shapes: turn order is
  stored as ESPN's reported sequence rather than derived from a snake formula,
  each roster entry carries an optional format-specific detail slot (unused by
  snake), and event consumers MUST tolerate an unfamiliar event kind without
  failing. Adding a second format later MUST NOT change how existing consumers
  read state or subscribe to events. No auction behavior is implemented here.

**Following the draft**

- **FR-007**: While a draft is live **and at least one client is connected**,
  the system MUST observe ESPN on a **two-tier adaptive cadence** (ratified in
  clarification): a 10-second baseline, tightening to 3 seconds once the owner
  is within 3 picks of their turn and until their pick is made.
- **FR-007a**: A live session MUST keep running until the draft completes
  whether or not any client is connected (ratified in clarification). While
  unattended it MUST observe ESPN on a slow 30-second cadence, and MUST return
  to FR-007's tiers within one cycle of a client connecting — so a reconnecting
  client is served a current snapshot rather than waiting for a full rebuild.
- **FR-008**: Observation MUST stay respectful of ESPN: a bounded, documented
  maximum request rate per league, exponential back-off on errors, no polling
  while a session is idle/armed beyond a slow heartbeat, and no polling at all
  once the draft is complete.
- **FR-009**: The system MUST be strictly read-only against ESPN — it never
  submits a pick, sets autodraft, or writes any draft data (Constitution VI).

**Authoritative state**

- **FR-010**: Draft state MUST include: every pick made (overall pick number,
  round, pick-in-round, drafting team, player), each team's roster so far, the
  team currently on the clock, the owner's **full remaining pick schedule**
  (every pick number still coming to them, nearest first — not just the next
  one, so a consumer can reason across rounds), picks until the owner's turn,
  and the set of players still available.
- **FR-011**: The available-player set MUST be the league's player board (002)
  minus everyone drafted and minus pre-draft rostered/keeper players.
- **FR-012**: ESPN MUST be the source of truth: on every read, state reconciles
  to ESPN's reported picks, tolerating corrections, undos, and reordering
  without producing duplicate or phantom picks.
- **FR-013**: Draft state MUST be durable — it survives process restarts and
  redeploys without requiring a full rebuild, and remains queryable after the
  draft completes. A completed draft MUST be **retained indefinitely as season
  history** (ratified in clarification, mirroring 002's projection-set
  retention); no pruning or cleanup job removes it. The retained record MUST be
  sufficient to reconstruct the draft without ESPN: every pick in order, the
  pre-draft keeper/rostered assignments, the draft order, the league's team
  roster, and which team was the owner's.
- **FR-014**: The system MUST be able to rebuild complete draft state from
  ESPN alone, with no reliance on previously stored state, and the rebuilt
  state MUST be identical to state built incrementally from the same draft.
- **FR-014a**: Recovery MUST NOT depend on a client reconnecting. If a live
  session dies while unattended, the same scheduled scan that arms sessions
  MUST notice the gap and restore it (rebuilding per FR-014) with no user
  action — otherwise the always-on guarantee of FR-007a fails silently exactly
  when nobody is watching.

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
  `pick_made`, `on_deck`, `on_the_clock`, and `draft_complete`, each carrying
  enough context for a consumer to act without re-reading ESPN. Every event MUST
  carry the **revision** it was emitted under, and within a revision each
  occurrence is emitted **exactly once**. A correction (FR-012) bumps the
  revision and replays the affected turns under the new number — so
  exactly-once is a per-revision property, not a per-draft one. Consumers
  deduplicate on `(revision, kind, overall pick number)` and treat a revision
  bump as "rewind to the correction point and re-apply".
- **FR-020**: `on_deck` MUST fire **as early as the draft's structure allows,
  at most two picks ahead** of the owner's turn — always exactly once, always
  before that turn's `on_the_clock` — so a recommendation can be pre-computed
  before the owner is on the clock (Constitution V). It MUST carry the real
  distance (`picks_until` = 2, 1, or **0**): at snake round boundaries the owner
  picks back-to-back, so there is no moment when they are two picks from the
  second turn, and `on_deck` fires with no lead. It is **never suppressed** in
  that case. Consumers MUST read `picks_until` rather than assume 2 — feature
  006 pre-computes its second pick off `on_the_clock(T)` instead of waiting for
  `on_deck(T+1)`.
- **FR-020a**: A single observation MAY reveal several picks at once — fast
  picking, an autodraft run, or the unattended cadence of FR-007a. When it
  does, the system MUST still emit every event the skipped states imply, in
  draft order: `on_deck` is never omitted merely because the owner's turn was
  reached inside one observation, and no event is emitted twice. Events derived
  from one observation MUST carry that observation's time, so a consumer can
  tell a collapsed batch from a genuine live sequence.
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
- **FR-024a**: A session is long-lived and its record is kept forever
  (FR-013), so ESPN credentials MUST NOT be written into draft state, session
  storage, or the retained history — they are read from encrypted storage for
  each ESPN request and held no longer than the request needs. No credential
  material reaches the client in any form, including session status payloads
  (constitution: Security & Privacy).
- **FR-025**: The app MUST provide a **plain diagnostic page** per connected
  league (ratified in clarification) showing session status, the live pick
  feed, the team on the clock, each team's roster so far, picks until the
  owner's turn, and the staleness age when degraded — enough to sit through a
  real draft and verify the
  monitor by eye. It is explicitly throwaway scaffolding: it MUST NOT be
  styled to the design system or reuse 007's ratified draft-room design, and
  007 replaces it wholesale rather than inheriting it.

### Key Entities

- **Draft Session** *(per league connection, per season)*: status (unsupported,
  idle, armed, live, degraded, complete, **aborted**), **draft format** (explicit
  discriminator — snake this season), scheduled time, draft order (or unknown),
  the owner's slot, last successful ESPN read time, whether any client is
  attached (drives cadence), and the current pick pointer.
- **Draft Pick**: draft format, overall pick number, round, pick-in-round,
  drafting team, player reference, observed-at time, and an optional
  format-specific detail slot (unused for snake). Ordered by overall pick
  number; the full set is the draft's history.
- **Team Draft Roster**: an ESPN team's picks so far in this draft, including
  pre-draft keeper/rostered players.
- **Draft Event**: kind (`pick_made`, `on_deck`, `on_the_clock`,
  `draft_complete`, `draft_revised` — an open set, per FR-006a), monotonic
  sequence number, **revision** (with kind and overall pick number, the dedupe
  key consumers use, per FR-019), payload, and the observation time it was
  derived from (shared by every event from one observation, per FR-020a) — the
  ordered stream clients and the engine consume.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During a live draft **with a client connected**, **95%** of picks
  made while the owner is more than 3 picks away are reflected in Draft Genie's
  state within 12 seconds of ESPN reporting them (10 s cadence plus one request
  round-trip), and 95% of picks made while the owner is within 3 picks of their
  turn within 4 seconds. **100% within the tier bound plus 60 seconds** (72 s
  and 64 s respectively) — the ceiling absorbs the platform's documented
  failover delay of up to a minute, which no application code can shorten.
  Measured over a full replayed draft, so it is checkable offline.
- **SC-001a**: With no client connected, **95%** of picks are recorded within
  35 seconds and 100% within 95 seconds (same ceiling rule), and a client
  connecting after any unattended stretch is served a complete, current
  snapshot with zero missing picks.
- **SC-002**: A connected client sees a state change within 1 second of the
  session recording it.
- **SC-003**: Across a full draft, every one of the owner's turns has exactly
  one `on_deck` emitted before that turn's `on_the_clock` **within each
  revision** — none skipped, none duplicated, never out of order. Where the two
  come from separate
  observations (the normal case at the 3-second tier) `on_deck` leads by at
  least one full pick; where a single observation reveals both, they are
  emitted in order within that batch and share an observation time, which is
  how the collapse is detected.
- **SC-004**: Reloading the client mid-draft restores complete, correct state
  in under 3 seconds, with zero missing picks.
- **SC-005**: Destroying the session mid-draft and rebuilding from ESPN
  reproduces identical draft state (same picks, rosters, on-the-clock team,
  available set) in under 10 seconds for a full 12-team, 16-round draft — and
  a session destroyed while no client is connected is restored by the
  scheduled scan alone, with no client action.
- **SC-006**: Joining a draft already in progress yields 100% of prior picks.
- **SC-007**: With ESPN unavailable for 60 seconds mid-draft, no state is lost,
  the staleness age is shown, and every pick made during the outage is present
  within one polling cycle of recovery.
- **SC-008**: Zero write requests are issued to ESPN across a full monitored
  draft, and per-league request volume stays within the documented rate bound.
- **SC-009**: Two leagues drafting concurrently each maintain complete and
  correct state, with no cross-contamination of picks or events.
- **SC-009a**: Format-neutrality check: no shared state field or event payload
  requires knowing the format is snake in order to be interpreted, and a
  hypothetical second format can be represented purely by a new format value
  plus its own detail payload — no change to the entities, the read interface,
  or the subscription contract. The shared shapes may carry ordinal sequence
  fields (overall pick number, round, pick-in-round); a format populates the
  ones it defines and leaves the rest empty, so their presence is not a snake
  assumption. A consumer fed an unfamiliar event kind continues working.
- **SC-010**: A full recorded draft replayed through the session produces the
  exact expected event sequence — one `pick_made` per pick in order, paired
  `on_deck`/`on_the_clock` per owner turn, one terminal `draft_complete`. The
  recorded sequence MUST be captured from a real ESPN draft and kept in the
  repository as a fixture, so this check runs offline at any time rather than
  waiting for draft day.
- **SC-010a**: A completed draft's full pick record is still queryable after
  the season ends, after subsequent projection refreshes, and after a redeploy
  — no scheduled cleanup removes it.
- **SC-011**: The monitor is validated end-to-end against at least one real
  ESPN draft (or a full captured pick feed from one) before draft day, watched
  through the diagnostic page of FR-025 — every pick, the clock, and at least
  one reconnect confirmed by eye against ESPN's own draft room.

## Assumptions

- **Snake drafts this season** *(ratified in clarification)*: 001 already flags
  a league's draft as supported only when ESPN reports a snake draft. Auction
  drafts (budgets, nominations, bidding) and offline drafts surface as
  unsupported. The state model and event contract are shaped so auction can be
  added later without reworking consumers (FR-006a) — a format discriminator
  and an optional detail slot, not speculative auction machinery.
- **Polling is the mechanism** *(cadence ratified in clarification)*: ESPN
  offers no push API for drafts (constitution), so cadence and back-off are the
  levers. Live cadence is two-tier — 10 s baseline, 3 s within 3 picks of the
  owner's turn (FR-007). The armed-state heartbeat and error back-off curve
  remain FR-008's bounds, with exact values set in the plan.
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
  and replay/import/simulation tooling (008). This feature ships the state, the
  events, and the throwaway diagnostic page of FR-025 — 008 will build on the
  durable state this feature already keeps, and no separate recording pipeline
  is built here.
- **Draft-day environment**: the owner watches on one device at a time
  (occasionally two), on ordinary consumer broadband/Wi-Fi, with the ESPN draft
  room open in parallel — Draft Genie never replaces ESPN's own interface.
