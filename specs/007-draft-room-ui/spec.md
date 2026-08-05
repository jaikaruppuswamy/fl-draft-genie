# Feature Specification: Draft Room UI

**Feature Branch**: `007-draft-room-ui`

**Created**: 2026-08-05

**Status**: Draft

**Input**: ROADMAP 007 — "The screen open on the iPad/laptop during the draft… front and center when on the clock (and pre-computed on deck, Principle V) — the recommendation card with explanations and alternatives."

## Overview

This is the screen the owner actually looks at on draft day. Everything else in
the product has been building toward it: 001 connects the league, 002/003 build
the board, 004 adds signals, 010 + 005 deliver a correct live picture, and 006
turns all of it into "take this player, and here's why". None of that is visible
to the owner yet. This makes it visible.

**The visual design is already ratified and built.** A faithful mock-data port of
the ratified screen ships today at `/design/draft`. This feature wires real state
into that reference; it does not redesign it.

**This feature is where SC-005 becomes true or false.** 006 made a recommendation
*possible* before the clock starts; only the screen that asks for it at the right
moment makes it *ready*. That obligation was inherited in writing, and honouring
it is the single most important thing this feature does.

Draft Genie remains **read-only against ESPN** (Constitution VI). The owner picks
in ESPN's own interface. This screen advises and never acts.

## Clarifications

### Session 2026-08-05

- Q: How much of the draft board is visible during the draft — full grid, or a focused view? → A: **Settled by the ratified design, not by a decision here.** `/design/draft` is a two-column layout: the full grid of every team's picks on the left, and a fixed 318px rail on the right carrying the recommendation queue, roster needs and byes. No focus mode.
- Q: Where does the full reasoning go, given the rail has room for about one line per player? → A: The rail shows the single strongest reason per player, always visible without a tap; the full explanation opens in a detail panel, reusing the existing player-detail sheet pattern.
- Q: Should the screen alert the owner on deck / on the clock, and how? → A: **Visual only.** An unmistakable on-screen state change, no sound and no browser notification. Nothing to arm, nothing to permit, nothing that can silently fail.
- Q: How is SC-001 proven before draft day rather than after it? → A: By **replaying the archived draft into the screen at its real recorded timing** and measuring signal-to-render offline. SC-001 must be a number before the draft, not a promise.
- Q: Refresh the recommendation on every pick, or only near the owner's turn? → A: **Every pick.** The rail is never more than one pick stale, so being ready before the clock stops depending on catching a single moment — and the snake-turnaround problem dissolves entirely.
- Q: What ends the draft on screen, given the completion path has never run in production? → A: **Either signal.** The draft is complete when the completion event arrives **or** when every pick has been observed. The screen must not depend solely on a path with no production evidence.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tell me who to take, before the clock starts (Priority: P1) 🎯 MVP

The owner's turn is approaching. Before the timer starts, the screen is already
showing a ranked shortlist with the reasoning for each name — so when the clock
does start, the owner is choosing, not waiting.

**Why this priority**: it is the product. Everything upstream exists to make this
moment work, and a recommendation that arrives after the clock starts has failed
at exactly the moment it was built for (Constitution V).

**Independent Test**: replay a draft to the pick before the owner's turn and
confirm a recommendation is on screen before the turn begins, with reasoning
attached.

**Acceptance Scenarios**:

1. **Given** any pick lands, **When** it is processed, **Then** the recommendation
   on screen refreshes — so a ranked shortlist with reasoning is already current
   whenever the owner's turn begins, rather than being fetched at that moment.
2. **Given** the owner is on the clock, **When** they look at the screen, **Then**
   the recommendation is already there — no spinner, no empty state.
3. **Given** a pick is made by another team, **When** it lands, **Then** the
   recommendation updates to exclude that player.
4. **Given** the owner picks **back-to-back** at a snake turnaround, **When**
   their second turn begins, **Then** a recommendation for it is on screen,
   accounting for the player they just took.

---

### User Story 2 - Show me the reasoning, not a name (Priority: P2)

Each recommended player carries what moved them: the value, each rule adjustment
with its direction and size, whether the player is on the owner's preferred list
and what that preference was worth, and the next-best alternatives.

**Why this priority**: Constitution VII is explicit — "a bare name with no
reasoning is a spec violation". 006 emits every adjustment with a signed
magnitude and a named reason precisely so this screen can show them. Emitting
them and not drawing them would waste the whole point.

**Independent Test**: for every recommendation shown, confirm the reasoning is
visible without a further tap, and that a preferred player is visibly badged with
the value the preference contributed.

**Acceptance Scenarios**:

1. **Given** a recommended player, **When** the card is shown, **Then** its value
   and strongest reason are visible with no interaction, and the full breakdown —
   every adjustment with its direction and size, plus the alternatives — is one
   interaction away.
2. **Given** a player on the owner's preferred list, **When** they appear,
   **Then** they are visibly badged as preferred and the screen shows what the
   preference was worth.
3. **Given** a recommendation where no rule fired, **When** it is shown, **Then**
   the screen says so plainly rather than showing an empty reasoning area.
4. **Given** a player ranked below the shortlist, **When** the owner asks about
   them, **Then** the same depth of reasoning is available for that player.

---

### User Story 3 - Show me the draft as it happens (Priority: P3)

The picks as they land, the owner's roster so far, whose turn it is, and how many
picks until the owner's next turn.

**Why this priority**: it is the context that makes a recommendation legible —
"why is a kicker suddenly on the list" is answered by the board, not the card.
Valuable, but the recommendation is useful before it exists.

**Acceptance Scenarios**:

1. **Given** a pick is made, **When** it lands, **Then** it appears on screen
   without the owner refreshing.
2. **Given** the owner has drafted players, **When** they look at their roster,
   **Then** it shows what they have and what they still need.
3. **Given** the draft order is not yet published by ESPN, **When** the screen
   loads, **Then** it says so rather than showing an invented order.
4. **Given** the draft has not started, **When** the owner opens the screen,
   **Then** it shows the countdown and the draft order if known.

---

### User Story 4 - Survive draft day going wrong (Priority: P4)

The tab reloads, the network drops, the tap stops reporting. The screen recovers
by itself, and when it cannot, it says so plainly instead of showing a stale board
as though it were current.

**Why this priority**: Constitution V — "a live draft cannot be paused or
replayed". A screen that silently goes stale during the one hour it exists for is
worse than no screen, because the owner trusts it.

**Independent Test**: reload mid-draft and confirm full state returns without
manual steps; sever the connection and confirm the screen says so and recovers.

**Acceptance Scenarios**:

1. **Given** the owner reloads mid-draft, **When** the screen comes back, **Then**
   the full draft state returns, with no picks missing and no manual action
   required.
2. **Given** the connection drops, **When** it is restored, **Then** any picks
   that happened during the gap appear, without duplicates.
3. **Given** 005 reports the draft picture as untrustworthy, **When** the owner
   looks at the screen, **Then** recommendations are withheld and the screen
   states why and what to do about it.
4. **Given** the connection cannot be restored, **When** the screen is stale,
   **Then** it says so visibly rather than continuing to look live.

---

### Edge Cases

- **The snake turnaround.** The owner picks back-to-back, so the on-deck warning
  for their second pick cannot arrive two picks early — it structurally cannot
  exist. This is the case where the inherited obligation *as written* was
  impossible to satisfy; FR-003's refresh-every-pick removes the problem rather
  than working around it. Still worth testing explicitly (SC-009), because it is
  where a regression would show first.
- **The owner's very first pick** — the screen must be ready before the draft
  starts, not only once the first pick has landed.
- **A correction.** 005 bumps its revision and replays affected turns; a
  recommendation computed for a superseded state must not stay on screen.
- **The draft completes.** Untested territory: draft-end detection, the archive
  write and the keeper path have never run against real data together
  (production holds zero archived drafts). FR-022 concludes completion from
  either the signal or the pick count, so neither untested path is load-bearing
  alone.
- **The two completion routes disagree** — the signal says done, the pick count
  says otherwise, or the reverse. The screen shows complete and surfaces the
  disagreement (FR-022b); it is the first real evidence about which route to
  trust.
- **The draft length is wrong**, as it was during the only live test. A too-low
  total would declare completion early, which is why the signal route exists
  alongside it.
- **The tap is on a different device** from this screen — the ratified design
  assumes exactly that, so this screen may be the only place a tap failure is
  visible to the owner.
- **A very long draft** — the pick feed must not grow without bound on a device
  left open for hours.
- **Keeper leagues**, where players are rostered before pick 1.
- **The owner opens the screen on a phone**, which the ratified design does not
  target.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The screen MUST show a **ranked shortlist with reasoning** when the
  owner is on or approaching the clock, drawn from 006's ranked board.
- **FR-002**: A recommendation MUST be **on screen before the owner's turn
  begins**, in the ordinary case — not requested when the turn starts
  (Constitution V).
- **FR-003**: The screen MUST refresh the recommendation on **every pick**, so it
  is never more than one pick stale — whoever the pick belonged to, and however
  far away the owner's turn is.
- **FR-003a**: Consequently, **being ready before the clock does not depend on
  catching a single moment.** FR-002 is satisfied by construction rather than by
  timing: there is no one request that can be missed, arrive late, or fail and
  leave the owner with nothing when their turn begins.
- **FR-004**: The **on-deck** and **on-the-clock** signals drive the screen's
  **visual state** (FR-023), not its fetching. This dissolves the snake
  turnaround as a special case entirely: the owner's second consecutive pick
  needs no earlier warning, because the recommendation is already current from
  the pick they just made. *(This satisfies the obligation inherited from 006
  more strongly than the wording it inherited — see Dependencies.)*
- **FR-005**: A recommendation MUST be **recomputed and re-shown when a pick
  lands**, so a player taken by another team never remains recommended.
- **FR-006**: Every recommended player MUST show, **without any interaction**,
  its value and the **single strongest reason** it is being recommended. No
  recommended player is ever shown as a bare name (Constitution VII).
- **FR-006a**: The **full reasoning** — every rule adjustment that applied with
  its direction and size, any missing inputs, and the alternatives considered —
  MUST be reachable in **one interaction** from the recommendation, in a detail
  panel. The rail is 318px wide by ratified design and cannot hold eight
  adjustments legibly at arm's length; hiding the headline reason behind a tap
  would be the opposite error.
- **FR-007**: A player on the owner's **preferred list** MUST be visibly marked
  as such, and the screen MUST show **what the preference contributed** — 006
  emits both as first-class fields for this purpose.
- **FR-008**: When **no rule fired** for a recommendation, the screen MUST say so
  plainly rather than showing an empty area.
- **FR-009**: The owner MUST be able to see the **same depth of reasoning for a
  player below the shortlist**, using 006's on-demand explanation.
- **FR-010**: The screen MUST show the **draft as it happens** — picks landing
  without a refresh, whose turn it is, and how many picks until the owner's next
  turn.
- **FR-011**: The screen MUST show the **owner's roster so far** and what the
  league still requires them to fill.
- **FR-012**: The screen MUST **recover full state after a reload**, mid-draft,
  with no picks missing and no action required from the owner.
- **FR-013**: The screen MUST **reconnect automatically** after a dropped
  connection and MUST recover picks that landed during the gap **without
  duplicating** any (005's stream supports resume by cursor).
- **FR-014**: When 005 reports the picture **untrustworthy**, the screen MUST
  withhold recommendations and **state the reason and the remedy** — never show a
  stale board as current.
- **FR-015**: When the screen itself is **disconnected or stale**, it MUST look
  visibly different from a live one.
- **FR-016**: A recommendation from a **superseded revision** MUST NOT remain on
  screen after a correction.
- **FR-017**: Before the draft, the screen MUST show the **countdown** and the
  **draft order once ESPN publishes it**, and MUST say plainly when the order is
  not yet known rather than inventing one.
- **FR-018**: The screen MUST link to the **preferred-list page**, which 006
  already ships. It MUST NOT reimplement list management.
- **FR-019**: The screen MUST match the **ratified visual design** already ported
  to `/design/draft`. This feature wires state into that reference and does not
  reopen the design.
- **FR-020**: Draft Genie MUST NOT submit a pick, or write anything to ESPN, from
  this screen (Constitution VI). The owner picks in ESPN.
- **FR-021**: The pick feed MUST remain **bounded** on a device left open for the
  length of a draft.
- **FR-022**: The screen MUST treat the draft as **complete** when **either** the
  completion signal arrives **or** every pick in the draft has been observed —
  whichever happens first. It MUST then show a final summary of the owner's
  roster and stop offering recommendations.
- **FR-022a**: Neither route may be the only one. The completion signal has
  **never fired in production** — 005's own archive count is zero, because the
  draft length was unknown during the only live test — so a screen that waited
  solely on it would be relying on a path with no evidence behind it. Equally,
  the pick count depends on a draft length that has itself been wrong before, so
  it cannot be the only route either. Two independent routes to the same
  conclusion is the point.
- **FR-022b**: If the draft is complete by **one route but not the other**, the
  screen MUST still show it as complete, and the disagreement MUST be visible to
  the owner rather than resolved silently. That divergence is the first evidence
  anyone will have about which route is trustworthy.
- **FR-023**: The screen MUST make **on deck** and **on the clock** unmistakable
  through a **visual state change** — legible at arm's length on an iPad, without
  the owner reading any text. No sound and no browser notification.
- **FR-023a**: The visual alert is understood to reach the owner **only while
  they are looking at the screen**. This is an accepted limitation, not an
  oversight: the alternatives that would reach further both fail silently — audio
  is blocked without a prior gesture, and notifications need a permission the
  owner may decline. The screen MUST NOT imply it will fetch the owner's
  attention from elsewhere.
- **FR-024**: **SC-001 and SC-009 MUST be verifiable offline**, by replaying an
  archived draft into the screen at its real recorded per-pick timing and
  measuring the interval from the earliest available signal to the recommendation
  being on screen. No live draft, and no network.
  *Why this is a requirement and not a testing note*: SC-001 is the reason this
  feature exists, and a criterion that can only be checked during the one hour
  that cannot be repeated is not a criterion. This project has three times
  shipped work marked done that production later showed was never exercised —
  005's archive write, 010's page-world preflight, and the arming path. The
  archived corpus carries a real `observedAt` per pick, so the measurement is
  available without waiting for August.

### Key Entities

- **Draft room view**: everything on screen for one league at one moment — the
  board, the owner's roster, the turn state, and the current recommendation.
- **Connection state**: whether the screen is live, reconnecting, or stale, and
  what the owner should do about it.
- **Rail entry**: one recommended player as the rail shows them — name, value,
  the headline reason, and the preferred badge. The full breakdown lives in the
  detail panel, not here. *(Called `RailEntry` in the data model; "the rail" is
  the region, "rail entry" is one row. ROADMAP's phrase "recommendation card",
  quoted in Input above, means this — one name is used from here on.)*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In at least **95% of the owner's turns**, a recommendation is on
  screen before the turn begins, measured from the earliest signal available for
  that turn. *(This is 006's SC-005, measurable for the first time.)*
  **Verified offline**, by replaying an archived draft at its real recorded
  timing — not deferred to draft day (FR-024). On the archived corpus, which is
  6 teams × 12 rounds and therefore gives the owner exactly **12 turns**, 95%
  rounds up: **all 12 must pass**, at every modelled latency the harness sweeps.
  The 95% figure is the standard for a real draft, where turn counts are larger.
- **SC-002**: **100%** of recommendations shown carry a visible value and reason
  with no interaction; none is a bare name. The full breakdown is reachable in
  one interaction for 100% of them.
- **SC-003**: A pick made by any team appears on screen within **2 seconds** in
  95% of cases and within 10 seconds in all cases — matching the delivery budget
  005 already meets. Measured in the same offline replay as SC-001, from each
  frame's recorded arrival to its placement on the board.
- **SC-004**: After a **mid-draft reload**, the full draft state is restored with
  **zero missing and zero duplicated picks**, in 100% of trials.
- **SC-005**: After a **dropped connection**, picks that landed during the gap
  appear once reconnected, with **zero duplicates**, in 100% of trials.
- **SC-006**: With 005 reporting the picture untrustworthy, the screen withholds
  recommendations and states the reason in **100%** of trials.
- **SC-007**: A player on the preferred list is visibly badged, with the
  preference's contribution shown, in **100%** of cases where one appears.
- **SC-008**: Across a full-length draft the screen's retained state stays
  **bounded**: raw frames are not accumulated, and the objects held grow only
  with picks made — never with frames received. Asserted by driving the reducer
  with more frames than a draft contains and confirming retained state tracks
  pick count, not frame count. *(Previously "usable without degradation", which
  named no measurable thing.)*
- **SC-009**: At a snake turnaround, a recommendation for the owner's **second
  consecutive pick** is on screen when that turn begins, in at least 95% of cases
  — and in **every** such turn of the archived corpus, for the reason given in
  SC-001.
- **SC-010**: On deck and on the clock are **distinguishable from the ordinary
  state, and from each other, without reading text** — verifiable from a
  screenshot alone.
- **SC-011**: The screen reaches its completed state in **100%** of trials by
  each route independently — with the completion signal alone, and with the pick
  count alone — proving neither is load-bearing by itself.

## Assumptions

- The **visual design is settled** (ratified 2026-08-02) and already ported to
  `/design/draft`. This feature changes what feeds it, not what it looks like.
- **005's stream is sufficient** — it already delivers picks, turn events, resume
  by cursor after a gap, and the withholding verdict. No new server-side
  live-draft capability is assumed.
- **006's board is sufficient** — it already returns a full ranked ordering, a
  shortlist with explanations, per-adjustment signed magnitudes, the preferred
  flag, and an on-demand explanation for any player. No new engine work is
  assumed.
- **Preferred lists are per league and season** — resolved by 006 and no longer
  open. ROADMAP's question about sharing them across leagues is closed.
- The **tap runs on a different device or tab** from this screen, per the ratified
  design, so this screen is where a tap failure becomes visible.
- Target devices are **iPad and desktop browsers**, per the constitution's
  delivery target. Phone is not a target.
- **Snake drafts only**, matching 005's ratified scope.

## Dependencies

- **005** — the live stream, turn events, resume, and the withholding verdict.
  Shipped and deployed.
- **006** — the ranked board, explanations, preferred badge data, and the
  on-demand explanation. Shipped and deployed 2026-08-05.
- **The ratified design** — `/design/draft` and the "Organic" system already in
  `web/src/styles.css`.

**A contract correction this feature forces.** 006's `contracts/api.md` §1a, and
ROADMAP's note under 007, both say consumers MUST request on the on-deck signal
and **never** on the clock.

That wording is wrong twice over, and clarification found both:

1. **It is impossible at a snake turnaround.** 005's event model is explicit —
   `on_deck` fires "as early as the draft's structure allows, at most two picks
   ahead", and the owner's second consecutive turn can only ever be one pick
   away, so an on-deck signal for it cannot exist. The rule as written could not
   be honoured 12 times in a 12-round draft.
2. **It prescribes a mechanism where it meant an outcome.** What 006 actually
   needed was "a recommendation is current when the turn begins". Refreshing on
   every pick (FR-003) delivers that far more robustly than any single trigger,
   because there is no one request whose failure leaves the owner with nothing.

006's contract should be **restated as the outcome** — the recommendation must be
current when the owner's turn begins — rather than prescribing which event to
listen for. Left as-is it governs an implementation it disagrees with, and it
would push a future consumer toward the fragile design.

## Out of Scope

- **Preferred-list management** — 006 owns it and already ships the page. This
  screen links to it.
- **Changing the recommendation rules** — 006 owns the engine; rule tuning is its
  own later session.
- **The replay lab** and any "how well did it do" scoring — 008 owns it.
- **Redesigning the draft screen** — the design is ratified.
- **Automated picking.** Constitution VI is absolute.
- **Phone layouts** — outside the constitution's stated delivery target.

