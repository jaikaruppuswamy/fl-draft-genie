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

Around that pure core, this feature also ships the **preferred-player list** —
storage, a read/write API, and a plain page to enter it. The list is an *input*
to the engine, so the core stays pure; but nothing else owns it, and without it
the preference rule would never fire on a real draft day.

The rule set is **not user-configurable** (Constitution IV). There are no weights
to tune in a settings page. The rules are the product.

## Clarifications

### Session 2026-08-05

- Q: Should the engine return only a short list of the top few players, or a full ranked ordering of everyone still available? → A: Full ranked board of every available player, with full explanations on the shortlist head only and value/rank for the rest.
- Q: Where does the owner's preferred-player list live? → A: This feature owns it — storage, a read/write API, and a plain standalone page to enter it. The draft room stays 007's.
- Q: Should the engine reason about which players are likely gone before the owner's next turn? → A: Yes — estimate survival to the next turn from ADP and the number of intervening picks, and let it adjust value. No opponent model.
- Q: When a mandated position (K/DST) is unfilled and picks are running out, enforce or advise? → A: Enforce only when forced — while picks remaining exceed unfilled mandatory slots, rank by value and warn; once they are equal, the shortlist head is mandated positions only.
- Q: What is the preferred-player boost measured in? → A: Value in the league's own currency, capped relative to that league's value spread. The preference must additionally be a distinctly marked adjustment carrying the exact value it contributed, so a display can badge the player as preferred and show what the preference was worth.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tell me who to pick (Priority: P1) 🎯 MVP

The owner is on the clock. Draft Genie shows a short, ranked list of players to
take right now, best first, drawn from who is actually still available in this
draft and valued in this league's own scoring. Behind that shortlist sits the
full ranked board of everyone still available, so the question "and after those?"
always has an answer.

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

Before draft day the owner marks the players they want, on a plain page of their
own. During the draft the engine lets a preferred player be taken somewhat
earlier than raw value alone would justify — but only somewhat, and it says when
a preference is what moved them.

**Why this priority**: it personalises the advice without letting it become a
rubber stamp. Valuable, but the engine is useful before it exists.

**Independent Test**: Save a list on the page, confirm it survives a reload and is
invisible to another account; then rank a pool with and without a preferred
marking and confirm the player moves up by a bounded amount, never past a player
worth materially more, and that the explanation names the preference.

**Acceptance Scenarios**:

1. **Given** the owner is signed in, **When** they add and remove players on the
   preferred-list page, **Then** the list persists per league and season, and is
   visible only to that account.
2. **Given** a preferred player, **When** recommendations are produced, **Then**
   they may rank above a slightly better-valued player; the player is flagged as
   preferred, and the explanation carries the exact value the preference added.
3. **Given** a preferred player worth far less than the best available, **When**
   recommendations are produced, **Then** the preference does **not** lift them
   to the top — the boost is bounded.
4. **Given** no preferred players at all, **When** recommendations are produced,
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

1. **Given** 005 reports the **draft state** as known-stale — the tap has lapsed,
   so picks are provably being missed — **When** a recommendation is requested,
   **Then** the engine returns no recommendation and states why. A stale *player
   board* is a different case: it is surfaced, not withheld (scenario 3).
2. **Given** signals are unavailable for some players, **When** recommendations
   are produced, **Then** those players are still ranked on value alone and the
   explanation notes the missing signal.
3. **Given** projections are stale, **When** recommendations are produced,
   **Then** the staleness is surfaced alongside the results.

---

### Edge Cases

- **The owner picks back-to-back** at a snake turn. The second recommendation
  must account for the player just taken by the first — and the gap to the "next
  turn" is one pick, not a round, so nothing is treated as safely surviving.
- **A player has no ADP** — obscure, newly added, or sitting at ESPN's saturation
  floor, which is the majority case. Survival cannot be estimated for them; they
  rank on what is known, per FR-013.
- **The late rounds, where almost everyone is at the ADP floor.** Survival stops
  discriminating exactly when the draft does. The engine must fall back to value
  and stated need without pretending the floor is a signal.
- **A pick is corrected** after the fact (005 bumps its revision). A
  recommendation computed for a superseded state must not be presented as
  current.
- **Late rounds**, where roster slots are nearly full and the remaining need is
  narrow — the pick at which a kicker or defence stops being optional (FR-025).
- **More unfilled mandatory slots than picks remaining** — already unsatisfiable.
  The engine must say so plainly and still rank, not silently recommend as though
  the roster could be completed.
- **Every remaining player fills no need** — the roster is complete but picks
  remain. Ranking continues on value; nothing is forced.
- **A drafted player is not on the board at all** — obscure or newly added. Must
  not crash or corrupt the available pool.
- **Two players are exactly equal** on every input. Ordering must still be
  deterministic.
- **Keeper leagues**, where players are rostered before the draft begins.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The engine MUST produce a **total ranked ordering of every
  available player** for a given draft state, best first, and MUST designate a
  **shortlist head** — the top few, whose size is fixed in code, not configurable
  (Constitution IV) — as the answer to "who do I take right now".
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
  including a run on a position. Scarcity is measured backward, from picks
  already made; the forward-looking counterpart is FR-022.
- **FR-007**: A **preferred player** MUST be able to rank above their raw value
  by a boost expressed **in the league's own value currency** (Constitution III),
  capped at an amount sized **relative to that league's own value spread** — not
  a flat point count — so the rule means the same thing in every league
  (Constitution II). The cap is fixed in code, not configurable (FR-011); its
  magnitude is tuning, deferred to `/speckit-plan`.
- **FR-008**: Recommendations MUST respect **roster construction**: what the
  owner still needs, and what the league requires them to fill before the draft
  ends. The mandatory-slot rule is FR-025.
- **FR-009**: Every player in the **shortlist head** MUST carry a full
  **explanation** naming the value, each rule adjustment that applied and its
  direction, and the alternatives considered (Constitution VII). Players ranked
  below the head MUST carry at least their value and rank; because the engine is
  deterministic (FR-010), a full explanation for any one of them MUST be
  obtainable on demand from the same inputs, so 008 can interrogate a player the
  owner actually took without the engine emitting an explanation per player per
  pick.
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
- **FR-018**: This feature MUST **store the owner's preferred-player list**, per
  league connection and season, and expose reading and editing it. The list is an
  input to the engine, not part of it — the engine stays pure (FR-010).
- **FR-019**: A **plain page** MUST let the owner build that list before draft
  day: find a player from the league's own board (002/003), add them, remove
  them, and see the current list. The draft-room interface remains 007's.
- **FR-020**: The list MUST be **isolated per account** — one owner can never
  read or write another's preferred list (Constitution, Security & Privacy). A
  list for a league connection the requester does not own MUST be unreachable,
  not merely unrendered.
- **FR-021**: A preferred player who is **not on the league's board** — released,
  retired, or never listed — MUST NOT break the list or the ranking; they are
  simply never recommended, and the page says why they cannot be used.
- **FR-022**: The engine MUST estimate whether each player **survives to the
  owner's next turn**, from the board's ADP and the number of picks that fall
  between now and that turn, and MUST let that estimate adjust value — so a
  player certain to be gone is preferred over an equally valued player certain to
  last. The estimate MUST be derived from data already on hand: **no model of
  what specific opponents will do**, no network, no loss of determinism (FR-010).
  ESPN's ADP **saturates at a floor** (measured 2026-08-05: 325 of 522 projected
  players sit at ~169.9, against a maximum of 171.6). A value at that floor means
  "outside our sample", not "goes at pick 170", and the engine MUST treat it as
  an **absent** ADP under FR-013 — never as a real draft position. Ranking a
  floored player as safely surviving would be a fabricated signal, and it would
  fire hardest in the late rounds where it is least true.
- **FR-023**: When there **is no next turn** — the owner's final pick of the
  draft — survival MUST NOT be applied, and its absence MUST NOT be reported as a
  missing signal. At a snake turnaround the gap is the real, small one; the
  engine MUST use the actual intervening pick count, not an assumed round.
- **FR-024**: The survival estimate MUST be **named in the explanation** when it
  moved a player (Constitution VII) — "unlikely to last to your next turn" is a
  reason the owner can weigh; a shifted number is not.
- **FR-025**: While the owner's **remaining picks exceed their unfilled mandatory
  slots**, the engine MUST rank by value and MUST surface a standing warning
  naming the unfilled slots and how many picks remain. Once remaining picks
  **equal** unfilled mandatory slots, every further pick is forced: the shortlist
  head MUST contain only players who fill one, and the explanation MUST say the
  pick is forced rather than chosen. The engine MUST NOT weight a mandated
  position upward before that point — a kicker must never displace a starter
  while there is still room for both.
- **FR-026**: When the preference moved a player, the recommendation MUST carry
  it as a **distinctly identified adjustment** — a flag marking the player as
  preferred, and the **exact value the preference contributed**, in the league's
  currency, as its own addressable field. Not prose to be parsed, and not folded
  into a combined total. A display MUST be able to badge the player as preferred
  and show what the preference was worth without recomputing anything. This is
  the contract 007 renders against; 006 owns the data, 007 owns the pixels.
- **FR-027**: Every adjustment MUST carry its **own signed magnitude** in the
  same currency, not only its direction, so the values in an explanation sum to
  the difference between raw value and final value. An explanation whose parts do
  not reconcile to its total is a defect.

### Key Entities

- **Ranked board**: the total ordering of every available player for one draft
  state, plus which of them form the shortlist head.
- **Recommendation**: a player, their rank, the computed value, the adjustments
  applied, and — for the shortlist head — the explanation.
- **Adjustment**: one rule's effect on one player — which rule, which direction,
  its signed magnitude in the league's currency, and why it fired. The preference
  is one of these, distinctly identified so a display can badge it.
- **Roster need**: what the owner's roster still requires by position, and what
  the league mandates before the draft ends.
- **Preferred player**: a player the owner has marked as wanted, held per league
  connection and season, owned by exactly one account.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of picks in a replayed archived draft, a ranked
  recommendation is produced containing only available players.
- **SC-002**: 100% of shortlist-head entries carry an explanation naming at least
  the value and the alternatives; none is a bare name. Every player below the
  head carries a value and a rank, and a full explanation can be obtained for any
  of them on demand.
- **SC-003**: Running the engine twice over the identical draft state produces
  identical output in 100% of trials.
- **SC-004**: The same player pool evaluated under two different league scoring
  settings produces demonstrably different rankings.
- **SC-005**: A recommendation is ready by the time the owner is on the clock in
  at least 95% of turns, measured from the on-deck signal.
- **SC-006**: Marking a player preferred raises their value by no more than the
  cap in 100% of cases, measured directly from the preference adjustment's own
  recorded magnitude — and a player whose raw value trails the leader by more
  than the cap never ranks first.
- **SC-007**: With the draft state reported known-stale, the engine returns no
  recommendation and states the reason in 100% of trials.
- **SC-008**: With signals removed for a subset of players, those players are
  still ranked and their explanations name the missing input, in 100% of cases.
- **SC-009**: The engine runs to completion over a full archived draft with no
  network access available.
- **SC-010**: Every recommendation is reproducible from the archived draft record
  alone — the same pick history yields the same advice.
- **SC-011**: A preferred list saved on the page survives a reload and a new
  session, and a request for another account's list is refused in 100% of
  attempts.
- **SC-012**: Given two players of equal value, one whose ADP falls inside the
  gap to the owner's next turn and one well beyond it, the engine ranks the
  first higher and names the reason, in 100% of trials. At the owner's final
  pick the same pair ranks by value alone, with no survival reason given.
  Players at ESPN's ADP floor are treated as having no ADP in 100% of cases —
  no survival claim is made for them, in either direction.
- **SC-013**: With one mandatory slot unfilled and two picks remaining, the
  shortlist head is ranked on value and carries the warning; with one pick
  remaining it contains only players filling that slot, in 100% of trials.
- **SC-014**: For every recommendation a preference moved, the output carries a
  preferred flag and the exact value the preference contributed, readable without
  parsing prose. Across a full replayed draft, each explanation's adjustment
  magnitudes sum to the difference between the player's raw and final value, in
  100% of cases.

## Assumptions

- The **player board (002/003)** supplies per-league scored projections, ADP and
  bye weeks; this feature does not re-derive them. Verified against production
  2026-08-05: ADP is present on 100% of the 522 projected players and already
  reaches the client. The universe is 1026 active players, so ~504 carry neither
  a projection nor an ADP; they also carry no value, so they rank last regardless.
  ADP discriminates for roughly the first 170 picks — enough for a standard
  draft's meaningful rounds, and enough at K and DST (real values from 85.3 and
  89.4) for FR-025's endgame — but **not** to the end of a 16-round board. See
  FR-022 on the floor.
- **Player search** for the preferred-list page (FR-019) needs no new backend:
  the board endpoint already returns the whole scored board, and client-side name
  and position search already ships in the league board page. FR-019 reuses that
  pattern rather than adding a search endpoint or a name index.
- The **signals (004)** supply team offense, strength of schedule and O-line rank
  in a uniform shape, including their own freshness.
- The **draft state (005)** supplies which players are gone, whose turn it is,
  the owner's roster so far, and whether the picture is trustworthy.
- **Snake drafts only**, matching 005's ratified scope. Auction is out.
- Recommendations are **advisory**. Draft Genie never makes a pick — it is
  read-only against ESPN (Constitution VI), and the owner picks in ESPN.
- The engine's **numeric tuning** — the exact replacement baselines, and every
  magnitude including the size of the preferred cap and how heavily each signal
  and the survival estimate weigh — is deliberately deferred to `/speckit-plan`
  and its own tuning session, per ROADMAP. *How* adjustments combine is no longer
  open: they are additive in the league's own currency and must reconcile
  (FR-027).

## Dependencies

- **002 + 003** — the per-league player board. Shipped.
- **004** — context signals. Shipped.
- **005** — live draft state, the event contract, and the archived draft record.
  Shipped; the archive path landed 2026-08-05.
- **010** — the tap that feeds 005. Shipped.

## Out of Scope

- The **draft-room interface** — 007 owns it. This feature produces
  recommendations; it does not display them. The one page it does ship is the
  preferred-list editor (FR-019), which is not the draft room and is used before
  draft day, not during it. The preferred badge and its value, likewise: 006
  emits the flag and the number (FR-026), 007 draws them.
- The **replay lab** and any "how well did it do" scoring — 008 owns it.
- **Auction** drafts, matching 005's ratified scope.
- **Automated picking.** Constitution VI is absolute: Draft Genie observes and
  advises, never acts in ESPN.
