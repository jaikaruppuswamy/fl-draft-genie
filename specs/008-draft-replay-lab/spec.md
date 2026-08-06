# Feature Specification: Draft Replay Lab

**Feature Branch**: `008-draft-replay-lab`

**Created**: 2026-08-05

**Status**: Draft

**Input**: ROADMAP 008 — "The test harness that makes the secret sauce trustworthy. Record every live draft the monitor observes; import past ESPN drafts; replay any recorded draft against the current engine to see what Draft Genie would have recommended at each of the user's picks; run simulated drafts (ADP-driven opponents) to sanity-check rule changes before draft day."

> **On the number.** This feature is **008**, not 011. Feature numbers are the
> `specs/` directory identifiers, and 010-draft-tap was inserted out of sequence
> (numbered after 009, executed before 005) precisely to avoid renumbering four
> downstream features. A naive "next sequential number" scan of `specs/` would
> have produced 011 and broken every cross-reference in the shipped specs and in
> the constitution, which cites "ROADMAP.md feature 008" by name.

## Overview

Draft Genie currently ships **twelve tuning constants that nobody has ever
scored**. `src/engine/constants.ts` says so in as many words: the weights, caps
and thresholds were chosen for the right order of magnitude and the right
*relative* ordering, and 006's roadmap entry records that "scoring them against
outcomes needs 008's replay lab". Until that lab exists, every rule change to
the product's secret sauce is a guess that ships straight to draft day, where it
cannot be undone.

This feature closes that. It is the instrument that turns "this weight feels
about right" into "moving this weight changed the engine's judgement at 23 of 84
turns in the corpus, in this direction, by this much".

**The constitution makes it mandatory, not optional.** The Development Workflow
section states: *"The recommendation engine MUST be testable offline via
recorded/replayed drafts (see ROADMAP.md feature 008) — rule changes are
validated against replays before draft day."* Today that sentence describes
something that does not exist. Principle IV compounds the obligation: the rules
are code, and rule changes get their own spec sessions — but a spec session with
no evidence is just a longer guess.

**This feature does not change a single rule.** It is the measuring device, not
the thing measured. Any change to a weight, cap or threshold that this lab
motivates is a *separate* spec session under Principle IV. The lab informs; a
human decides; the engine is never written to automatically.

**Three uncomfortable facts shape everything below**, each verified against the
code rather than assumed:

1. **The archive is empty, but the raw material is not.** 005 built the
   recording path — `draft_archives`, `draft_picks`, per-pick `observed_at`,
   oracle verification — and it has never written a row in production; it is
   gated on two unfinished items (draft-end detection, keeper pick-count
   reconciliation). What *has* been running is 010's retention: `tap_batches`
   holds every accepted frame from every draft the tap has seen, privacy-filtered
   at the boundary, and `reconcile()` is pure — no database, no clock, no live
   session. So the lab builds its corpus by reconciling retained frames offline
   and by importing completed drafts ESPN still serves, and depends on the
   archive path for neither.

   **What has been captured so far is the owner's own test runs.** That is
   enough to prove the reconciler and the replay path work against real relay
   frames, and it is not evidence about anything: a mock room does not draft the
   way a real one does. So the *evidential* corpus is empty today, and its first
   entries arrive with the first real 2026 league draft.

2. **The engine's inputs decay, and two of them decay to nothing.** Team signals
   are keyed `(kind, pro_team_id)` and overwritten in place — no history, no
   season column — so a past draft's offence/SoS/O-line values are simply gone,
   and they are recomputed in lockstep with every projection refresh. Projection
   sets look durable but are not: the maintenance cron runs `DELETE FROM
   projection_sets WHERE season < ?` unconditionally, so the 2026 sets vanish
   when the clock rolls to 2027, taking their per-player rows with them by
   cascade. The preferred-player list has no history either. **Left alone, a
   recorded draft is replayable only during its own season, and only partially
   even then.**

   Resolved by snapshotting the inputs into the corpus entry when the draft is
   recorded (see Clarifications). That makes an entry self-contained rather than
   a set of pointers into tables that will be overwritten — but it can only
   capture what exists at the time, which is why an imported past-season draft
   can never become replayable.

3. **Scoring the engine by projected points is circular.** The engine ranks by
   projected points; the entire rule layer exists *because* projections alone
   are insufficient. A metric built on projected points rewards any change that
   increases agreement with the input, which is the opposite of what tuning is
   for. The only non-circular measure is what the players actually scored.

   Getting those actuals is cheap — ESPN serves them from the same view the
   projections pipeline already reads, distinguished only by a source flag the
   pipeline currently filters out. **The timing is the problem, and it does not
   line up in either direction**: the 2026 draft can be replayed faithfully but
   has no actuals until January 2027, while an imported 2024 draft has actuals
   today but no contemporaneous projections, so the engine cannot be run on it
   at all. *No draft in existence can currently be both replayed and scored on
   outcomes.* This is why the lab's comparison measures are behavioural and its
   outcome measures are a reserved, deliberately empty slot.

Draft Genie remains **read-only against ESPN** (Constitution VI). Importing a
completed draft is a read of data ESPN reliably writes once the draft finishes —
the one view 005's Gate 0 proved dependable. Nothing here opens a draft-room
connection, and nothing here runs on draft day.

## Clarifications

### Session 2026-08-05

- Q: What should the lab treat as the measure of a good draft — the thing a rule change is judged to have improved or worsened? → A: **Behavioural now, outcome later.** Comparison between rule sets rests on structural measures — movement in the ordering in round-value units, changes of shortlist head, the size and direction of disagreement with the pick actually made, how often each rule was decisive. The scorecard reserves a defined place for outcome measures based on **actual season points**, left explicitly empty until the season has been played. **No projection-derived quality number may ever be reported as evidence that a rule change is an improvement** — it shares its source with the engine's own input, so it rewards agreement with projections, which is the thing the rule layer exists to correct.
- Q: Should a corpus entry capture the engine inputs it will be replayed against, or keep reading the live tables at replay time? → A: **Snapshot the inputs into the corpus entry.** At the moment a draft is recorded or imported, the league-scored board and the signal values then in effect are captured and stored with it; a replay reads those, never the live tables. This is the only arrangement under which a recorded draft stays replayable — the maintenance cron deletes prior-season projection sets outright, and signals are overwritten in place with no history. It is deliberately **additive**: 002's and 004's shipped behaviour is unchanged, the lab simply stops depending on it. **Limitation accepted:** a snapshot can only be taken where inputs exist, so imported past-season drafts can never receive one, and an already-captured 2026 draft can recover its board (the sets survive) but not its signals (recomputed since).
- Q: Now that a past-season import can never be replayed, what is the import capability actually for? → A: **Two different jobs, kept distinct.** Drafts in a season the projections pipeline covers are matched to the set that was serving at the draft's start time, snapshotted, and join the **replayable** corpus — which is what reaches 2026 leagues the tap never ran on. Drafts in seasons the pipeline never covered are imported as **pick-sequence-only**, permanently unreplayable, and used solely to characterise how real drafters behave relative to ADP, which is the one thing the opponent model has to be grounded in. The engine is never run against a pick-sequence-only entry.
- Q: Where should a live-observed draft enter the corpus from — the archive path, or the retained tap frames it was built from? → A: **From the retained frames, offline.** The lab runs the existing pure reconciler over retained relay batches and snapshots the inputs, with no dependence on the archive path or on draft-end detection — for a finished draft every frame is already there. This unblocks 008 from a path that has written zero rows in production, and makes drafts that have *already* run recoverable today rather than lost. The archive path remains 005's to finish; when it does, entries may arrive that way too, and the two routes must agree.
- Q: Where should the lab run from, and what should a run read — committed fixtures, or the live database? → A: **Repo harness; runs read committed fixtures only.** The lab adds no page, endpoint or code path to the deployed application. Admitting a draft is an explicit export step that snapshots its inputs, screens it, and writes a fixture; baseline scorecards are committed alongside, so a rule change is reviewable as a diff rather than a number someone reports. This is what makes "validated against replays before draft day" a gate instead of a habit. **Qualified by the owner in the same answer:** the drafts captured so far are *test runs*, and a mock room does not draft the way a real one does — so every entry records whether it is a real league draft or a test run, and test entries are **excluded from every scorecard used to compare rule sets**. They are kept rather than deleted, being the only proof the reconciler and replay path work against real frames. **Consequence stated plainly: the evidential corpus is empty today, and its first entries arrive with the first real 2026 league draft.**

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Show me what the engine would have done, turn by turn (Priority: P1) 🎯 MVP

The maintainer takes a real, completed draft and walks it forward pick by pick.
At each of the owner's own turns, they see the ranked board the engine would
have produced *at that exact moment* — the shortlist, the reasons, the signed
adjustments — set beside the player the owner actually took and where that
player sat in the engine's ordering.

Everything else in this feature is aggregation over this one act.

**Why this priority**: it is the first time anyone can look at the engine's
judgement across a whole real draft rather than at a hand-built state in a unit
test. 006 has 226 tests and every one of them asserts a rule in isolation; none
answers "is this thing sensible over 84 consecutive turns?". A maintainer who
can watch the engine disagree with a real draft, with reasons, can form a
judgement about the rules. Nobody can do that today.

**Independent Test**: replay one recorded draft end to end and confirm that
every one of the owner's turns produces a ranked board, an explanation for the
shortlist head, and the rank the actually-drafted player held — with no live
draft, no network, and no clock.

**Acceptance Scenarios**:

1. **Given** a recorded draft and the owner's team within it, **When** the
   replay reaches one of the owner's turns, **Then** the engine is invoked
   against the draft state as it stood immediately before that pick — the
   players already gone, the owner's roster so far, the gap to their next turn —
   and the resulting ranked board is recorded.
2. **Given** the owner actually drafted player P at that turn, **Then** the
   report states P's rank in the engine's ordering, P's value, and the gap
   between P and the engine's own first choice, in the league's value currency.
3. **Given** the actually-drafted player is absent from the engine's board
   entirely — obscure, released, or never projected — **Then** the report says
   so plainly and the turn still produces a result, rather than the replay
   failing.
4. **Given** the same recorded draft and the same rules, **When** the replay is
   run twice, **Then** the two reports are identical.
5. **Given** the replay walks a snake draft, **Then** the owner's turns are
   derived from the round and the order, never from a positional field on a pick
   record — the reading 010's oracle disproved at 5 of 70.

---

### User Story 2 - Tell me whether a rule change made things better or worse (Priority: P2)

The maintainer changes a weight. They re-run the whole corpus and get a
side-by-side: what the engine used to recommend at each turn, what it recommends
now, which turns changed at all, and by how much the ordering moved. They can
see whether the change did what they intended or something else.

**Why this priority**: this is the constitution's actual requirement — "rule
changes are validated against replays before draft day". US1 lets you *look*;
this lets you *decide*. Without a stored baseline to diff against, validation
degrades into remembering what the numbers looked like last week.

**Independent Test**: record a baseline over the corpus, change one constant,
re-run, and confirm the report names exactly the turns whose outcome changed and
quantifies the movement — and that changing nothing produces an empty diff.

**Acceptance Scenarios**:

1. **Given** a corpus and a rule set, **When** a run completes, **Then** it
   produces a scorecard that can be stored and later compared, stamped with the
   identity of the rules that produced it.
2. **Given** two scorecards from the same corpus under different rules, **When**
   they are compared, **Then** the comparison names every turn whose shortlist
   head changed, every turn whose ordering moved beyond a stated threshold, and
   leaves unchanged turns out of the report.
3. **Given** two scorecards from the same corpus under *identical* rules,
   **Then** the comparison is empty. A non-empty diff here is a determinism
   failure and must be reported as one, not as a rule effect.
4. **Given** a constant is swept across a range of values, **Then** one
   comparable scorecard is produced per value, so the shape of the effect is
   visible rather than a single before/after pair.
5. **Given** a run, **Then** it declares for every engine input whether it was
   reconstructed as of the draft or taken from today — and a run whose inputs
   cannot be reconstructed says so rather than substituting present-day values
   silently.

---

### User Story 3 - Give me a corpus without waiting a year (Priority: P3)

The maintainer points the lab at their ESPN account and imports the completed
drafts ESPN still serves, turning a corpus of one into a corpus of many.

**The imports do two different jobs and must not be confused.** A draft from a
season the projections pipeline covers can be matched to the set that was
serving at its start time, snapshotted, and replayed — this is what reaches the
owner's other current-season leagues, which the tap was never running for. A
draft from an earlier season can never be replayed, because no board for that
season exists or can be fetched; it is imported as a **pick sequence only**, and
its value is entirely in showing how real drafters behave relative to ADP —
which is the only empirical grounding the opponent model in US4 will ever have.

**Why this priority**: US1 and US2 are buildable and testable against the single
complete draft this project already holds (010's captured 72-frame corpus, with
its independent oracle). That is enough to *build* the lab and enough to prove
it works. It is nowhere near enough to *tune* with — twelve constants against
one draft's worth of turns is fitting noise. Import is what makes the lab useful
rather than merely correct, which is why it ranks below the two capabilities
that make it exist.

**Independent Test**: import one completed draft from ESPN and confirm the
resulting record matches ESPN's own view of that draft pick for pick, contains
no manager names or member identifiers, and can be replayed by US1 without
modification.

**Acceptance Scenarios**:

1. **Given** a league and season whose draft has completed, **When** it is
   imported, **Then** the record carries every pick — round, pick, team, player,
   keeper and autodraft flags — in a form indistinguishable to the replay from a
   live-recorded draft.
2. **Given** an import, **Then** manager names, member identifiers and free text
   are discarded at the boundary, before anything is stored or written to a
   file. Numeric identifiers only, exactly as 010 established.
3. **Given** an imported draft disagrees with its source on any pick, **Then**
   the divergence is recorded and reported rather than resolved silently in
   favour of either side.
4. **Given** a draft whose format is not snake, **Then** the import refuses it
   with a clear reason rather than importing it as though the order were a
   snake.
5. **Given** a draft in a season the projections pipeline covers, **When** it is
   imported, **Then** it is matched to the projection set that was serving at
   the draft's start time, that board is snapshotted with it, and the entry
   joins the replayable corpus.
6. **Given** a draft in a season the pipeline never covered, **When** it is
   imported, **Then** the entry is marked pick-sequence-only and permanently
   unreplayable, and no attempt to run the engine against it is possible.
7. **Given** a draft with keepers, **Then** those players are recorded as
   unavailable from pick one, on every team that held them — not only the
   owner's.

---

### User Story 4 - Let it play the draft itself (Priority: P4)

The maintainer runs a draft where the engine makes the owner's picks and
modelled opponents make everyone else's, then compares the roster it built
against the one the owner actually built.

**Why this priority**: it is the only way to see a *roster-level* consequence
rather than a per-turn one, and roster quality is ultimately what the engine is
for. It ranks last because it is the only capability whose output is
model-dependent: the moment the engine takes a different player, every real pick
after it becomes counterfactual, and the answer is only as good as the opponent
model. US1 through US3 produce facts; this produces an estimate, and an estimate
that is easy to over-trust.

**Independent Test**: run a simulated draft from the same starting conditions
twice with the same seed and confirm the two drafts are identical; run with two
different seeds and confirm the variation is bounded and reported.

**Acceptance Scenarios**:

1. **Given** a league shape and a board, **When** a simulated draft runs,
   **Then** every team's picks are produced by a stated opponent model and the
   owner's picks by the engine under test.
2. **Given** a simulation is run twice with the same seed, **Then** the two
   drafts are identical, pick for pick.
3. **Given** a simulation completes, **Then** the resulting roster is reported
   beside the owner's real roster from the corresponding recorded draft, using
   the same measure for both.
4. **Given** a simulated result is reported, **Then** it is labelled
   model-dependent and carries the opponent model's identity, so it is never
   filed alongside a shadow replay's findings as though the two had equal
   standing.

---

### Edge Cases

- **A drafted player has a negative identifier.** D/ST identifiers sit around
  −16000, and `playerId > 0` filtering is what made 010's capture report 66 of
  72 picks for a complete draft. Nothing in the lab may filter on sign.
- **A drafted player is not on the board.** Normal, not an error: obscure, newly
  added, or outside the serving projection set. The turn still produces a
  result; the player contributes nothing to roster needs or bye arithmetic.
- **The draft order was never published.** For an imported historical draft
  there may be no recorded order at all. The order must be derivable from the
  picks themselves, or the draft is marked unreplayable — never guessed.
- **The season has no projection set.** A 2024 draft cannot be replayed
  faithfully: no set was ever captured, and ESPN will not serve a past season's
  preseason projections. The lab must refuse to present such a run as a
  reconstruction.
- **The signals have moved on.** They always have — signals are overwritten in
  place. Every replay of every past draft is affected, including a 2026 draft
  replayed in September.
- **The league's scoring changed between the draft and today.** The stored
  snapshot is current, not versioned. A replay under different scoring is
  measuring a different league.
- **The live engine withholds recommendations.** In replay there is no tap and
  no liveness, so the withholding condition cannot arise. That difference must
  be explicit, not an accident of the harness passing an empty value.
- **ADP saturates.** 325 of 522 players share a floor value near 169.9 in the
  serving set, and the engine treats an ADP at or above the detected floor as
  absent. Replay must inherit that behaviour, not re-derive it differently.
- **Two runs of the same corpus disagree.** A determinism failure. It must fail
  loudly, because every comparison in US2 is worthless without it.
- **The owner's team cannot be identified in an imported draft.** Without it
  there are no "owner's turns" and nothing to report; the draft is importable as
  a pick sequence but not replayable.
- **A keeper league's pick count differs from teams × rounds.** 005 has this
  open; a corpus entry whose totals do not reconcile must be flagged rather than
  replayed against a wrong number of remaining picks.
- **The retained frames have a gap.** A batch was lost, or the tap was installed
  mid-draft. The entry must name the missing picks and refuse replay rather than
  present a shorter draft as a complete one.
- **A draft appears in both the retained frames and the archive.** The two must
  agree pick for pick; disagreement is reported, not resolved.
- **The corpus is empty.** Today it effectively is. The lab must behave sensibly
  with zero recorded drafts and say what is missing.

## Requirements *(mandatory)*

### Functional Requirements

**Replay (US1)**

- **FR-001**: The lab MUST reconstruct, for any recorded draft and any pick
  within it, the draft state as it stood immediately before that pick: the
  players unavailable, the owner's roster to that point, the current pick
  number, the gap to the owner's next turn, and the owner's remaining picks.
- **FR-002**: The lab MUST invoke the recommendation engine unmodified. It MUST
  NOT reimplement, approximate, or bypass any ranking rule; a second
  implementation of a rule the engine owns would diverge the day either changed.
- **FR-003**: The lab MUST produce, for every one of the owner's turns, the
  engine's full ranked ordering, the shortlist with its explanations, and the
  warnings the engine raised.
- **FR-004**: The lab MUST report, for every one of the owner's turns, the
  player actually drafted, that player's rank and value in the engine's
  ordering, and the value difference from the engine's first choice.
- **FR-005**: The lab MUST state plainly when the actually-drafted player is
  absent from the engine's board, and MUST still produce a result for that turn.
- **FR-006**: The lab MUST derive whose turn each pick is from the round and the
  published or reconstructed order, never from a positional field on a pick
  record.
- **FR-007**: The lab MUST apply the *real* picks as the draft advances (shadow
  replay). The engine's own preference MUST NOT alter the sequence in this mode,
  so that every turn is evaluated against the true board state.
- **FR-008**: The lab MUST run entirely offline: no live draft, no draft-room
  connection, no dependence on wall-clock time.
- **FR-009**: Replaying MUST be deterministic — the same corpus and the same
  rules MUST produce byte-identical output on every run.

**Scoring and comparison (US2)**

- **FR-010**: The lab MUST produce a scorecard summarising a run over one or
  many recorded drafts, in a form that can be stored and compared later.
- **FR-011**: Every scorecard MUST be stamped with the identity of the rules
  that produced it — the tuning constants in effect and the engine version — so
  that two scorecards can never be compared without knowing what differed.
- **FR-012**: The lab MUST compare two scorecards over the same corpus and
  report every turn whose shortlist head changed, every turn whose ordering
  moved beyond a movement threshold, and nothing else. The comparison MUST state
  the threshold it applied, so a reader can tell an unchanged turn from one that
  moved below the reporting bar.
- **FR-013**: A comparison of two runs made under identical rules MUST be empty,
  and a non-empty result MUST be reported as a determinism failure rather than
  as a rule effect.
- **FR-014**: The lab MUST support sweeping a single tuning constant across a
  range of values, producing one comparable scorecard per value.
- **FR-015**: Every run MUST declare, per engine input, whether that input was
  reconstructed as of the recorded draft or taken from the present day.
- **FR-016**: The lab MUST refuse to present a run as a faithful reconstruction
  when a required as-of input is unavailable. (The corpus-side consequence — what
  happens to an entry whose input cannot be captured — is FR-019d, which this
  requirement deliberately does not restate.)
- **FR-017**: The lab MUST NOT present any measure derived from projections as
  evidence that a rule change is an improvement. Comparison between rule sets
  MUST rest on behavioural measures: movement in the ordering expressed in
  round-value units, changes of shortlist head, the size and direction of
  disagreement with the pick actually made, and how often each rule was
  decisive.
- **FR-017a**: The scorecard MUST carry a defined place for outcome measures
  based on **actual season points**, populated once the season a recorded draft
  belongs to has been played, and left explicitly empty before then — never
  defaulted, approximated, or substituted with a projection-derived figure.
- **FR-018**: The lab MUST NOT write to the engine's tuning constants, or to any
  rule, under any circumstance. It reports; a human changes the code in a
  separate spec session (Principle IV).

**Corpus (US3)**

- **FR-019**: Every corpus entry MUST be replayable by the same path regardless
  of how it was produced — reconciled from retained relay frames, imported from
  ESPN, or supplied by the archive path once that works. The replay MUST NOT
  behave differently according to which route produced an entry.
- **FR-019a**: A corpus entry MUST carry the engine inputs a replay needs,
  captured at the moment the draft is recorded: the league-scored board as it
  then stood, and the signal values then in effect. A replay MUST read these from
  the entry and MUST NOT read the live projection or signal tables.
- **FR-019b**: A corpus entry MUST remain replayable after the live projection
  sets and signal values it was drawn from have been changed or deleted. Its
  replayability MUST NOT depend on when the replay is run.
- **FR-019c**: Capturing a snapshot MUST NOT alter, delete, or preserve anything
  in the live projection or signal tables. The lab reads them; the pipelines that
  own them keep their existing behaviour unchanged.
- **FR-019d**: Where an input cannot be snapshotted because it no longer exists,
  the entry MUST record that fact and MUST be marked unreplayable rather than
  snapshotted with a present-day substitute.
- **FR-019e**: The lab MUST be able to build a corpus entry for a live-observed
  draft directly from the retained relay frames, reusing the existing
  reconciler, without depending on the archive path or on draft-end detection.
- **FR-019f**: Where a draft is available both from retained frames and from the
  archive, the two MUST yield the same picks. Any disagreement MUST be reported,
  never silently resolved in favour of either route.
- **FR-019g**: Where the retained frames for a draft are incomplete, the entry
  MUST record which picks are missing and MUST be marked unreplayable rather
  than replayed as though it were a shorter draft.
- **FR-020**: The lab MUST import a completed draft from the owner's ESPN
  account, capturing every pick with its round, pick number, team, player, and
  keeper and autodraft flags.
- **FR-020a**: For a draft in a season the projections pipeline covers, import
  MUST match it to the projection set that was serving at the draft's start
  time, snapshot that board with the entry (FR-019a), and admit the entry to the
  replayable corpus.
- **FR-020b**: For a draft in a season the pipeline never covered, import MUST
  mark the entry **pick-sequence-only** and permanently unreplayable. The lab
  MUST NOT run the engine against such an entry under any circumstance, and MUST
  NOT include it in a scorecard used to compare rule sets.
- **FR-020c**: The lab MUST be able to characterise, from pick-sequence-only
  entries, how real drafters behaved relative to ADP — the empirical grounding
  for the opponent model (FR-028). The ADP used MUST be contemporaneous with the
  draft being measured, and where it is not, the lab MUST refuse to report a
  measurement rather than qualify one.

  > ⚠️ **Found unsatisfiable for past seasons on first real data (2026-08-05),
  > and the reason is structural rather than a defect.** A past-season pick
  > sequence has no contemporaneous ADP for exactly the reason it has no board:
  > the projections pipeline never covered that season, and ESPN serves preseason
  > projections for the current season only. Measuring a 2025 draft against 2026
  > ADP measures a year of player aging, injury and depth-chart change, with
  > drafter behaviour somewhere underneath.
  >
  > **This narrows what pick-sequence-only entries are for.** They cannot ground
  > the opponent model's noise. What they still carry is ADP-free structure —
  > positional run patterns, when kickers and defences go, how roster shape
  > drives late rounds — which is real but is not the parameter FR-028 needed.
  > Until a draft is admitted from a covered season, the opponent model runs with
  > `grounded: false` and says so in every result (FR-031).
  >
  > Note the resolution is benign: a draft from a covered season is *also*
  > replayable, so one admission serves both purposes.
- **FR-021**: Import MUST discard manager names, member identifiers and free
  text at the boundary, before anything is stored or written to a file. Only
  numeric identifiers and league shape may be retained.
- **FR-022**: Import MUST record, rather than silently resolve, any disagreement
  between what it captured and its source.
- **FR-023**: Import MUST refuse a draft whose format is not snake, with a
  stated reason.
- **FR-024**: The lab MUST record keepers as unavailable from pick one on every
  team that held them, not only on the owner's team.
- **FR-025**: The lab MUST mark a corpus entry unreplayable, with the reason,
  when its owner team, pick order, or contemporaneous board cannot be
  established — and MUST retain it for pick-sequence use rather than discarding
  it.
- **FR-026**: The lab MUST never filter players on the sign of their identifier.
- **FR-027**: Every corpus entry MUST be attributable to exactly one account and
  MUST never be readable across accounts (Constitution, per-user isolation).
- **FR-027a**: Every corpus entry MUST record whether it derives from a **real
  league draft** or a **test run** (a mock or rehearsal draft).
- **FR-027b**: A test-run entry MUST NOT contribute to any scorecard used to
  compare rule sets, and MUST NOT be cited as evidence for a rule change. It
  remains available as a harness fixture for proving the replay path works.
- **FR-027c**: The drafts captured to date MUST be classified as test runs. They
  MUST be retained, not deleted — they are the only evidence the reconciler and
  the replay path behave correctly against real relay frames.
- **FR-027d**: Where the evidential corpus is empty or too small to support a
  comparison, the lab MUST say so rather than reporting a comparison over test
  entries.

**Simulation (US4)**

- **FR-028**: The lab MUST run a full simulated draft in which the owner's picks
  come from the engine under test and every other team's picks come from a
  stated opponent model.
- **FR-029**: Simulation MUST be reproducible from a seed: the same seed and the
  same inputs MUST produce the same draft, pick for pick.
- **FR-030**: The lab MUST report a simulated draft's resulting roster beside
  the owner's real roster from the corresponding recorded draft, using one
  measure for both.
- **FR-031**: Simulated results MUST be labelled model-dependent and carry the
  opponent model's identity, and MUST NOT be reported alongside shadow replay
  findings as though the two carried equal evidential weight.

**Boundaries**

- **FR-032**: The lab MUST NOT alter, delay, or add any work to the live draft
  path. Nothing it introduces may run during a draft.
- **FR-033**: The lab MUST remain read-only against ESPN, and MUST NOT open a
  connection to any draft room (Constitution VI).
- **FR-034**: Any corpus committed to the repository MUST contain no ESPN
  credential, member identifier, manager name, or free text.

**Delivery**

- **FR-035**: The lab MUST run from the repository. It MUST NOT add a page, an
  endpoint, or any code path to the deployed application.
- **FR-036**: A run MUST read only committed corpus fixtures, and MUST NOT
  require access to production data or credentials.
- **FR-037**: Admitting a draft to the corpus MUST be an explicit step that
  exports it, snapshots its inputs, screens it for the prohibited fields, and
  writes it as a fixture — never an implicit consequence of running the lab.
- **FR-038**: Baseline scorecards MUST be storable in the repository, so that a
  rule change and its effect on the corpus are reviewable together as a diff.

### Key Entities

- **Recorded draft**: one completed draft available for replay — league shape
  (teams, rounds, scoring), pick order, every pick with its team and player and
  timing, keepers, the season it belongs to, and its provenance (observed live
  by the monitor, or imported from ESPN). Carries whether it is replayable and,
  if not, why.
- **Input snapshot**: the engine inputs captured with a recorded draft — the
  league-scored board and the signal values in effect at the time. What makes an
  entry self-contained, and therefore what makes it survive the annual prune and
  the in-place overwrite of signals. Absent for imported past-season drafts,
  which is precisely why those are not replayable.
- **Rule-set identity**: what the engine was, for a given run — its tuning
  constants and its version. Without this a scorecard is a number with no
  referent.
- **Input fidelity declaration**: per engine input, whether it was reconstructed
  as of the draft or taken from today. Attached to every run, not optional.
- **Turn observation**: the unit of evidence — one of the owner's turns, with
  the engine's ranked ordering and reasoning at that moment, and the player the
  owner actually took with its position in that ordering.
- **Scorecard**: an aggregate over the turn observations of a run, stamped with
  the rule-set identity and the fidelity declaration, storable and comparable.
- **Baseline**: a scorecard retained as the point of comparison for subsequent
  runs.
- **Opponent model**: the rule by which non-owner teams pick in a simulation,
  with its own identity and seed, characterised against the ADP-relative
  behaviour observed in pick-sequence-only entries. Simulation only.
- **Use class**: whether a corpus entry is *replayable* (carries an input
  snapshot) or *pick-sequence-only* (no board ever existed; usable for
  drafter-behaviour analysis and nothing else). A permanent property of the
  entry, not a runtime judgement.
- **Provenance class**: whether an entry came from a *real league draft* or a
  *test run*. Orthogonal to use class — a test draft can be perfectly replayable
  and still inadmissible, because a mock room's behaviour is not a real room's.
  Only entries that are both replayable and real are evidence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A maintainer can change one tuning constant and see its effect
  across the entire corpus, compared against the previous baseline, in **one
  command completing in under 5 minutes** for a corpus of ten drafts. A tuning
  session that costs an afternoon per change will not happen, and the constants
  will stay unscored.
- **SC-002**: Running the same corpus twice under the same rules produces
  **identical** output, every time. Any deviation fails visibly.
- **SC-003**: **100% of runs** declare, per engine input, whether it was
  reconstructed as of the draft or taken from today. It is not possible to
  obtain an undeclared run.
- **SC-004**: For **100% of the owner's turns** in a replayed draft, the report
  states where the actually-drafted player ranked in the engine's ordering — or
  states that the player was not on the board.
- **SC-005**: An imported draft matches its ESPN source **pick for pick**, or
  every divergence is enumerated. No import is ever silently partial.
- **SC-006**: **Zero** manager names, member identifiers, or free-text fields
  appear in any stored or committed corpus entry, verified automatically rather
  than by inspection.
- **SC-007**: A simulated draft run twice from the same seed is identical pick
  for pick, and every simulated finding is labelled model-dependent.
- **SC-008**: The live draft path is **unchanged**: no capability added by this
  feature is reachable from any live-draft flow, and the draft-day behaviour and
  latency measured before this feature are reproduced unchanged after it.
- **SC-009**: A recorded draft replays to **identical** output before and after
  the live projection sets and signal values it was drawn from are deleted or
  overwritten. The corpus has no shelf life.
- **SC-010**: **Zero** test-run entries appear in any scorecard used to compare
  rule sets, and a comparison attempted with an insufficient evidential corpus
  says so rather than producing a number.

## Assumptions

These are informed defaults chosen where the roadmap left the question open.
Each is a decision `/speckit-clarify` should ratify or overturn before planning.

- ~~The lab is an offline instrument.~~ **Ratified** in Clarifications — repo
  harness, no deployed surface, runs read committed fixtures only. ROADMAP's
  "CLI or UI" question is answered CLI. See FR-035 – FR-038.
- ~~The corpus lives in the repository as fixtures.~~ **Ratified** in
  Clarifications, together with the explicit admission step (FR-037).
- **Shadow replay is the mode of record.** Findings used to justify a rule change
  come from replays that apply the real picks. Simulation is a sanity check,
  never the evidence.
- ~~The metric of record.~~ **Ratified** in Clarifications — behavioural
  measures now, actual season points once a season has been played, and no
  projection-derived quality number reported as evidence at any point. See
  FR-017 / FR-017a.
- **The opponent model is ADP-driven with bounded, seeded noise.** Simple enough
  to state in one sentence and reproduce exactly; anything richer is a model
  whose error nobody can characterise.
- **The corpus lives in the repository as privacy-screened fixtures**, so that a
  comparison is reviewable in a diff and does not depend on production data
  being present on the machine running it.
- **Import covers the seasons the owner's ESPN account can still read**, and
  degrades to "no corpus for that year" rather than fabricating one.
- **Snake drafts only**, matching 005. Auction is out of scope everywhere in
  this product today.
- **The engine is treated as a black box with a stable interface.** The lab calls
  it the way production does and asserts nothing about its internals.

## Dependencies

- **006-recommendation-engine** — the subject under test. Its purity and
  determinism are what make an offline replay possible at all; its slow-half /
  fast-half input split is what lets a board be reconstructed once per draft and
  the per-pick state once per pick.
- **005-draft-monitor** — supplies the **pure reconciler** that turns relay
  frames into picks, the snake helpers that answer "whose turn is it", and the
  oracle comparison against ESPN's completed-draft view. Its *archive* path has
  never written a row in production and is gated on two unfinished items
  (draft-end detection, keeper pick-count reconciliation); by the ratified
  decision above, this feature does not wait for it and does not close it.
- **010-draft-tap** — the retained relay frames (`tap_batches`) that are the
  actual source of every live-observed corpus entry, and the privacy discipline
  every entry must inherit: numeric identifiers only, screened before storage.
- **002-projections-pipeline** — immutable, per-season retained projection sets
  are what make a contemporaneous board reconstructible for any season the
  pipeline covered. It is also the boundary of replay fidelity: no set, no
  faithful replay.
- **004-context-signals** — supplies the signals the engine consumes, **with no
  history**. A known fidelity limit, not a gap to close in this feature.
- **001-league-onboarding** — league scoring and roster shape, and the
  credentials an import reads with.

## Out of Scope

- **Changing any rule, weight, cap or threshold.** Principle IV requires a
  separate spec session, informed by this lab's output. Shipping a tuning change
  inside the feature that builds the measuring device would mean the device was
  never independently validated.
- **Automated tuning or optimisation.** No search over the constant space that
  writes a result back. A human reads the evidence and decides.
- **A user-facing replay experience.** Nothing in the shipped app changes.
- **Auction drafts**, in replay, import or simulation.
- **Cross-account corpora.** No account may see another's drafts, and no
  aggregate over multiple users' leagues is built here.
- **Retro-fitting signal history.** `signal_entries` stays as it is; the fidelity
  limit is declared rather than engineered away.
- **Changing live draft-day behaviour** in any respect.
