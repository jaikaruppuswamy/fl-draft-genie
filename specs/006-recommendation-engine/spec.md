# Feature Specification: Recommendation Engine

**Feature Branch**: `006-recommendation-engine`

**Created**: 2026-08-05

**Status**: Draft

**Input**: ROADMAP 006 — "The secret sauce. A pure, deterministic, offline-testable module: input = league context, draft state, player board and signals, plus the user's preferred list; output = a ranked shortlist with an explanation per player."

## Overview

When the owner is on the clock, Draft Genie says **who to pick and why**.
Everything built so far exists to make this possible: 001 connects the league,
002 builds the per-league player board, 003 refines it, 004 adds context
signals, and 010 + 005 deliver a correct live picture of the draft. None of that
helps the owner make a pick. This does.

The engine is **pure and deterministic**: the same inputs always produce the same
ranked output, with no clock, no network and no randomness. That is what makes it
testable offline against real archived drafts, and what will let 008 replay a
season and ask "would the engine have done better?".

The rule set is **not user-configurable** (Constitution IV). There are no weights
to tune in a settings page. The rules are the product.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tell me who to pick (Priority: P1) 🎯 MVP

The owner is on the clock. Draft Genie shows a short, ranked list of players to
take right now, best first, drawn from who is actually still available in this
draft and valued in this league's own scoring.

**Why this priority**: This is the feature. Everything upstream exists to enable
it, and nothing downstream — 007's draft room, 008's replay lab — has anything to
show without it. It is independently valuable on its own: a ranked shortlist at
the moment of the pick beats the static cheat sheet the owner uses today.

**Independent Test**: Replay an archived draft (005) to any pick, ask for a
recommendation, and confirm the list contains only undrafted players, ordered by
the engine's own value.

**Acceptance Scenarios**:

1. **Given** the owner is on the clock with players available, **When** a
   recommendation is requested, **Then** a ranked shortlist is returned, best
   first, containing only players not already drafted.
2. **Given** two leagues with different scoring (PPR vs standard), **When** the
   same player pool is evaluated, **Then** the rankings differ according to each
   league's own scoring — the engine never uses a league-agnostic ranking.
3. **Given** a player the owner's roster cannot use, **When** recommendations are
   produced, **Then** that player does not appear ahead of players who fill a
   real need.
4. **Given** the identical draft state twice, **When** recommendations are
   requested twice, **Then** the output is identical.

---

### User Story 2 - Show me why (Priority: P2)

Each recommended player carries its reasoning: the value that put it there, the
rule signals that moved it up or down, and what the next-best alternatives were.
The owner can disagree on an informed basis rather than trusting a name.

**Why this priority**: Constitution VII makes this non-negotiable — "a bare name
with no reasoning is a spec violation." It ranks second only because a shortlist
without an explanation is still usable for one pick, while an explanation without
a shortlist is useless. In practice they ship together.

**Independent Test**: For every recommendation in a replayed draft, assert an
explanation exists, names the specific signals that applied, and that removing a
signal from the input changes the explanation.

**Acceptance Scenarios**:

1. **Given** any recommended player, **When** the recommendation is shown,
   **Then** it states the player's value, every rule adjustment that applied with
   its direction, and the alternatives considered.
2. **Given** a player moved by a rule, **When** the explanation is read, **Then**
   the specific reason is named — a top-tier offense, a bye-week clash — not a
   bare score.
3. **Given** no rule adjustment applied, **When** the explanation is shown,
   **Then** it says so plainly rather than omitting the section.

---

### User Story 3 - Respect my preferences, within reason (Priority: P3)

The owner has players they want. The engine lets a preferred player be taken
somewhat earlier than raw value alone would justify — but only somewhat, and it
says when a preference is what moved them.

**Why this priority**: it personalises the advice without letting it become a
rubber stamp. Valuable, but the engine is useful before it exists.

**Independent Test**: Rank a pool with and without a preferred marking; confirm
the player moves up by a bounded amount, never past a player worth materially
more, and that the explanation names the preference.

**Acceptance Scenarios**:

1. **Given** a preferred player, **When** recommendations are produced, **Then**
   they may rank above a slightly better-valued player, and the explanation says
   the preference is why.
2. **Given** a preferred player worth far less than the best available, **When**
   recommendations are produced, **Then** the preference does **not** lift them
   to the top — the boost is bounded.
3. **Given** no preferred players at all, **When** recommendations are produced,
   **Then** results are exactly the value-and-rules ranking.

---

### User Story 4 - Be honest when the inputs are poor (Priority: P4)

When the board is stale, signals are missing, or the draft state is not
trustworthy, the engine says so rather than quietly recommending against bad
data.

**Why this priority**: it is the difference between a tool that fails safely and
one that misleads at the worst possible moment. It ranks last only because the
other stories must exist for it to have anything to qualify.

**Independent Test**: Withhold each input in turn and confirm the output states
the degradation rather than silently ranking.

**Acceptance Scenarios**:

1. **Given** 005 reports the board as known-stale, **When** a recommendation is
   requested, **Then** the engine returns no recommendation and states why.
2. **Given** signals are unavailable for some players, **When** recommendations
   are produced, **Then** those players are still ranked on value alone and the
   explanation notes the missing signal.
3. **Given** projections are stale, **When** recommendations are produced,
   **Then** the staleness is surfaced alongside the results.

---

### Edge Cases

- **The owner picks back-to-back** at a snake turn. The second recommendation
  must account for the player just taken by the first.
- **A pick is corrected** after the fact (005 bumps its revision). A
  recommendation computed for a superseded state must not be presented as
  current.
- **Late rounds**, where roster slots are nearly full and the remaining need is
  narrow — including whether a kicker or defence must be taken before the draft
  ends.
- **Every remaining player fills no need** — the roster is complete but picks
  remain.
- **A drafted player is not on the board at all** — obscure or newly added. Must
  not crash or corrupt the available pool.
- **Two players are exactly equal** on every input. Ordering must still be
  deterministic.
- **Keeper leagues**, where players are rostered before the draft begins.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The engine MUST produce a **ranked list of recommended players**
  for a given draft state, best first.
- **FR-002**: Recommendations MUST be drawn **only from players still
  available** — not drafted, and not already rostered (including keepers).
- **FR-003**: Player value MUST be computed in **the league's own scoring**
  (Constitution III). A league-agnostic ranking is a violation, not a fallback.
- **FR-004**: Value MUST account for **positional replacement level** — what the
  league would otherwise get at that position — so positions are comparable to
  each other rather than ranked in isolation.
- **FR-005**: Value MUST account for **where the pick sits in the draft**, so the
  engine can express that a player is worth more or less than the current slot.
- **FR-006**: The engine MUST apply rule adjustments for **team offensive
  potential**, **strength of schedule**, **bye-week conflicts** with the owner's
  existing roster, **offensive line rank**, and **positional scarcity**,
  including a run on a position.
- **FR-007**: A **preferred player** MUST be able to rank above their raw value
  by a **bounded** amount that cannot make a materially worse player the top
  recommendation.
- **FR-008**: Recommendations MUST respect **roster construction**: what the
  owner still needs, and what the league requires them to fill before the draft
  ends.
- **FR-009**: Every recommendation MUST carry an **explanation** naming the
  value, each rule adjustment that applied and its direction, and the
  alternatives considered (Constitution VII).
- **FR-010**: The engine MUST be **pure and deterministic**: same inputs, same
  output, with no clock, network, randomness or ambient state.
- **FR-011**: The rule set MUST NOT be user-configurable. No weights, toggles or
  thresholds are exposed as settings (Constitution IV).
- **FR-012**: The engine MUST **withhold recommendations** when the draft state
  is known-stale, and say why, rather than ranking against data known to be wrong
  (005 FR-007f).
- **FR-013**: Missing or stale **signals MUST degrade gracefully** — the player
  is ranked on what is known, and the explanation states what was missing.
- **FR-014**: The engine MUST be **replayable offline** against archived drafts,
  with no live draft and no network.
- **FR-015**: A recommendation MUST be available **before the owner is on the
  clock**, computed from the on-deck signal so the answer is ready rather than
  starting when the timer does.
- **FR-016**: The engine MUST handle a **draft-state revision** by recomputing; a
  recommendation from a superseded revision MUST NOT be presented as current.
- **FR-017**: Ordering MUST be **total and stable** — players equal on every
  input still order deterministically.

### Key Entities

- **Recommendation**: a player, their rank, the computed value, the adjustments
  applied, and the explanation.
- **Adjustment**: one rule's effect on one player — which rule, which direction,
  and why it fired.
- **Roster need**: what the owner's roster still requires by position, and what
  the league mandates before the draft ends.
- **Preferred player**: a player the owner has marked as wanted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of picks in a replayed archived draft, a ranked
  recommendation is produced containing only available players.
- **SC-002**: 100% of recommendations carry an explanation naming at least the
  value and the alternatives; none is a bare name.
- **SC-003**: Running the engine twice over the identical draft state produces
  identical output in 100% of trials.
- **SC-004**: The same player pool evaluated under two different league scoring
  settings produces demonstrably different rankings.
- **SC-005**: A recommendation is ready by the time the owner is on the clock in
  at least 95% of turns, measured from the on-deck signal.
- **SC-006**: Marking a player preferred moves them up by no more than the stated
  bound in 100% of cases, and never makes a materially worse player rank first.
- **SC-007**: With the draft state reported known-stale, the engine returns no
  recommendation and states the reason in 100% of trials.
- **SC-008**: With signals removed for a subset of players, those players are
  still ranked and their explanations name the missing input, in 100% of cases.
- **SC-009**: The engine runs to completion over a full archived draft with no
  network access available.
- **SC-010**: Every recommendation is reproducible from the archived draft record
  alone — the same pick history yields the same advice.

## Assumptions

- The **player board (002/003)** supplies per-league scored projections, ADP and
  bye weeks; this feature does not re-derive them.
- The **signals (004)** supply team offense, strength of schedule and O-line rank
  in a uniform shape, including their own freshness.
- The **draft state (005)** supplies which players are gone, whose turn it is,
  the owner's roster so far, and whether the picture is trustworthy.
- **Snake drafts only**, matching 005's ratified scope. Auction is out.
- Recommendations are **advisory**. Draft Genie never makes a pick — it is
  read-only against ESPN (Constitution VI), and the owner picks in ESPN.
- The engine's **numeric tuning** — exact replacement baselines, the arithmetic
  by which adjustments combine, and the size of the preferred bound — is
  deliberately deferred to `/speckit-clarify` and `/speckit-plan`, per ROADMAP's
  note that detailed rule tuning is its own session.

## Dependencies

- **002 + 003** — the per-league player board. Shipped.
- **004** — context signals. Shipped.
- **005** — live draft state, the event contract, and the archived draft record.
  Shipped; the archive path landed 2026-08-05.
- **010** — the tap that feeds 005. Shipped.

## Out of Scope

- The **draft-room interface** — 007 owns it. This feature produces
  recommendations; it does not display them.
- The **replay lab** and any "how well did it do" scoring — 008 owns it.
- **Auction** drafts, matching 005's ratified scope.
- **Automated picking.** Constitution VI is absolute: Draft Genie observes and
  advises, never acts in ESPN.

## Clarifications Needed

- [NEEDS CLARIFICATION: Does this feature own the preferred-player list itself —
  storing it and letting the owner edit it — or does it consume a list owned
  elsewhere? No existing feature provides one, and 007 (the UI) comes after this.]
- [NEEDS CLARIFICATION: Should the engine return only a shortlist (roughly 3-5
  players), or also a full ranked board of everyone still available? 007 and 008
  may want the full ordering; a shortlist alone is simpler and matches "the right
  player when you're on the clock".]
- [NEEDS CLARIFICATION: When the league mandates a position the owner has not
  filled and picks are running out (kicker, defence), should the engine ENFORCE
  it — recommending only that position — or advise it strongly while still
  ranking better players above it?]
