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

1. **Given** the owner is two picks away, **When** the draft advances, **Then** a
   ranked shortlist is on screen with an explanation per player, before the
   owner's turn begins.
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

1. **Given** a recommended player, **When** the card is shown, **Then** the value,
   each adjustment that applied with its direction, and the alternatives are
   visible.
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
  exist. See FR-004; this is the one case where the inherited obligation *as
  written* is impossible to satisfy.
- **The owner's very first pick** — the screen must be ready before the draft
  starts, not only once the first pick has landed.
- **A correction.** 005 bumps its revision and replays affected turns; a
  recommendation computed for a superseded state must not stay on screen.
- **The draft completes.** Untested territory: draft-end detection, the archive
  write and the keeper path have never run against real data together
  (production holds zero archived drafts). The screen must handle completion
  arriving, *and* handle it never arriving.
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
- **FR-003**: The screen MUST request a recommendation on the **earliest signal
  that exists for that turn**. In the ordinary case that is the on-deck signal,
  which arrives up to two picks ahead.
- **FR-004**: At a **snake turnaround**, where the owner's second turn is
  structurally at most one pick away and no earlier signal can exist, the screen
  MUST request on the on-the-clock signal for that turn. This is not a relaxation
  of FR-002 — it is the earliest moment that exists. *(005's event model already
  says so; 006's contract asserted "never on the clock" without the exception,
  and that wording needs correcting — see Dependencies.)*
- **FR-005**: A recommendation MUST be **recomputed and re-shown when a pick
  lands**, so a player taken by another team never remains recommended.
- **FR-006**: Every recommended player MUST show its **reasoning**: the value,
  each rule adjustment that applied with its direction and size, and the
  alternatives considered (Constitution VII).
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
- **FR-022**: When the draft **completes**, the screen MUST say so. It MUST also
  behave sensibly if completion never arrives, because that path has never run
  against real data.

### Key Entities

- **Draft room view**: everything on screen for one league at one moment — the
  board, the owner's roster, the turn state, and the current recommendation.
- **Connection state**: whether the screen is live, reconnecting, or stale, and
  what the owner should do about it.
- **Recommendation card**: one recommended player as shown — name, value,
  reasoning, preferred badge, alternatives.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In at least **95% of the owner's turns**, a recommendation is on
  screen before the turn begins, measured from the earliest signal available for
  that turn. *(This is 006's SC-005, measurable for the first time.)*
- **SC-002**: **100%** of recommendations shown carry visible reasoning; none is
  a bare name.
- **SC-003**: A pick made by any team appears on screen within **2 seconds** in
  95% of cases and within 10 seconds in all cases — matching the delivery budget
  005 already meets.
- **SC-004**: After a **mid-draft reload**, the full draft state is restored with
  **zero missing and zero duplicated picks**, in 100% of trials.
- **SC-005**: After a **dropped connection**, picks that landed during the gap
  appear once reconnected, with **zero duplicates**, in 100% of trials.
- **SC-006**: With 005 reporting the picture untrustworthy, the screen withholds
  recommendations and states the reason in **100%** of trials.
- **SC-007**: A player on the preferred list is visibly badged, with the
  preference's contribution shown, in **100%** of cases where one appears.
- **SC-008**: The screen remains usable for a **full-length draft** on one device
  without degradation.
- **SC-009**: At a snake turnaround, a recommendation for the owner's **second
  consecutive pick** is on screen when that turn begins, in at least 95% of cases.

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

**A contract correction this feature forces**: 006's `contracts/api.md` §1a and
ROADMAP's note under 007 both say consumers must request on the on-deck signal
and **never** on the clock. 005's own event model documents the exception — at a
snake turnaround the owner's second turn can only ever be one pick away, so the
on-deck signal for it cannot exist. FR-004 states the correct rule; 006's
contract wording should be amended to match rather than left contradicting the
implementation it governs.

## Out of Scope

- **Preferred-list management** — 006 owns it and already ships the page. This
  screen links to it.
- **Changing the recommendation rules** — 006 owns the engine; rule tuning is its
  own later session.
- **The replay lab** and any "how well did it do" scoring — 008 owns it.
- **Redesigning the draft screen** — the design is ratified.
- **Automated picking.** Constitution VI is absolute.
- **Phone layouts** — outside the constitution's stated delivery target.

## Clarifications Needed

- [NEEDS CLARIFICATION: How much of the draft board should be visible during the
  draft — the full grid of every team's picks, or a focused view centred on the
  owner's turn with the grid available on demand? The ratified design shows a
  full grid, but an iPad at arm's length may favour focus. This decides what the
  primary live layout is.]
- [NEEDS CLARIFICATION: Should the screen alert the owner when they are on deck
  or on the clock — and if so, visually only, or with sound? The tap is expected
  to be on another device and this screen may be backgrounded, which is exactly
  when an alert matters and exactly when a browser is least able to give one.]
