# Feature Specification: Context Signals

**Feature Branch**: `004-context-signals`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "004" (ROADMAP.md feature 004 — context-signals: the non-projection signals the secret sauce needs — team offensive potential, strength of schedule, offensive line rankings — normalized and versioned for uniform consumption)

## Clarifications

### Session 2026-08-02

- Q: What should measure opponent defensive strength inside the SoS calculation? → A: Derived from the already-ingested D/ST season projections (zero new sources; refreshes automatically with every projection update).
- Q: How should SoS weight the season's weeks? → A: Playoff-weighted — all scheduled weeks count, fantasy-playoff weeks 15–17 count double.
- Q: Which public source should seed the curated O-line rankings each preseason? → A: PFF's preseason offensive line rankings, transcribed once a year into the repo file with attribution and date.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See a player's context signals (Priority: P1)

Opening a player's detail from the board now shows a **Signals** section
alongside the projection breakdown: the player's NFL team's offensive
potential (rank among the 32 teams), the team's strength of schedule (rank,
where 1 = easiest), the team's offensive line rank, and the bye week (already
known from 002). Each signal shows its rank and a plain-language label (e.g.
"Top-5 offense", "Bottom-10 O-line").

**Why this priority**: These are the exact factors the owner drafts by (the
product brief's rule list); surfacing them per player makes draft prep
smarter today and proves the data exists before the engine (006) consumes it.

**Independent Test**: Open an elite skill player's detail — team offense
rank, SoS rank, and O-line rank all display with plausible values; a player
on a weak offense shows correspondingly weak ranks.

**Acceptance Scenarios**:

1. **Given** signals have been computed, **When** a projected player's detail
   opens, **Then** it shows team offensive potential rank, SoS rank, O-line
   rank, and bye week, each with a readable label.
2. **Given** a player whose team lacks a value for some signal (e.g. no
   O-line entry), **When** the detail opens, **Then** that signal shows a
   dash — never an error or a fabricated value.
3. **Given** a free-agent player (no NFL team), **When** the detail opens,
   **Then** all team signals show dashes.

---

### User Story 2 - Signals stay consistent and fresh (Priority: P2)

Signals recompute automatically whenever projections refresh (daily in draft
season, draft-day top-up included), so they always describe the same world
the projections do. Each signal set records when and from what it was
computed. A failed recompute keeps the previous signals serving.

**Why this priority**: Stale or half-updated signals silently skew future
recommendations; the freshness machinery already exists (002) and signals
must ride it.

**Independent Test**: Trigger a projection refresh; signal computed-at
timestamps advance in lockstep. Simulate a failure; previous signals still
serve.

**Acceptance Scenarios**:

1. **Given** a projection refresh completes, **When** signals recompute,
   **Then** their computed-at matches the new projection set and every team
   has fresh values.
2. **Given** a signal recompute fails, **When** a player detail opens,
   **Then** the last successful signals display (labeled by their age via
   the board's existing freshness surface).

---

### User Story 3 - Uniform signal shape for the engine (Priority: P3)

Every signal — regardless of origin (computed from projections, derived from
the NFL schedule, or curated) — is stored in one uniform shape: signal kind,
subject (NFL team), raw value, normalized 0–100 score, rank 1–32, and
provenance (source + computed/seeded date). Adding a future signal requires
no change to how consumers read signals.

**Why this priority**: This is the contract feature 006 builds against; it
has no direct UI beyond US1 but determines how cheaply new sauce ingredients
get added later.

**Independent Test**: Enumerate stored signals: all kinds share the same
shape; a hypothetical new kind can be added as data without schema change.

**Acceptance Scenario**: **Given** the three signal kinds exist, **When**
read through the uniform interface, **Then** each exposes (kind, team, raw
value, normalized score, rank, provenance) identically.

---

### Edge Cases

- NFL team with no projected players in the serving set (weird but possible
  early preseason): offensive-potential rank computed from whatever exists;
  team never absent from the rank table silently — worst case it ranks last
  with a zero raw value.
- Schedule not yet published or partially published: SoS computes over the
  known weeks; if none are known, SoS shows dashes rather than fake ranks.
- O-line curated data missing a team (expansion/typo): that team shows a
  dash; a completeness check flags curated files that don't cover all 32
  teams at load time.
- Ties in raw values: broken deterministically by team id (total order), so
  ranks are always a distinct 1–32 permutation, stable across recomputes.
- Signals must never block or slow the board/detail beyond the existing
  performance criteria (002 SC-001).

## Requirements *(mandatory)*

### Functional Requirements

**Signal kinds (v1)**

- **FR-001**: The system MUST provide a **team offensive potential** signal:
  each NFL team's total projected offensive fantasy output for the season,
  derived from the serving projection set (no external source), normalized
  and ranked 1–32.
- **FR-002**: The system MUST provide a **strength of schedule** signal per
  NFL team: opponent difficulty derived from the published NFL schedule
  combined with opponent defensive strength **derived from the serving D/ST
  projections** (ratified in clarification — no external source), weighting
  all scheduled weeks with fantasy-playoff weeks 15–17 counted double,
  normalized and ranked (1 = easiest schedule).
- **FR-003**: The system MUST provide an **offensive line rank** signal from
  a curated, provenance-attributed data set seeded each preseason from PFF's
  public offensive line rankings (ratified in clarification; versioned with
  the code, attribution + date recorded in the file), covering all 32 teams,
  with a load-time completeness check.
- **FR-004**: Bye weeks (already ingested in 002) MUST be exposed alongside
  the other signals in the detail view — no re-ingestion.

**Uniformity & storage**

- **FR-005**: All signals MUST share one uniform shape: kind, NFL team, raw
  value, normalized 0–100 score, rank, and provenance (source identifier +
  computed/seeded timestamp).
- **FR-006**: Signal reads MUST NOT require consumers to know a signal's
  origin; adding a new signal kind MUST NOT change the read interface.

**Freshness**

- **FR-007**: Computed signals (offense, SoS) MUST recompute automatically
  after every successful projection refresh, deriving from the new serving
  set; curated signals reload when their data changes.
- **FR-008**: A failed recompute MUST leave the previous signal values
  serving (all-or-nothing per signal kind, matching 002's refresh
  semantics).

**Display**

- **FR-009**: The player projection detail MUST show the player's team
  signals (offense rank, SoS rank, O-line rank, bye) with plain-language
  labels; missing values display as dashes (never errors).
- **FR-010**: Free agents and teamless entries show dashes for all team
  signals.

### Key Entities

- **Signal Set** *(global)*: one signal kind's values for all teams at a
  point in time: kind, provenance, computed-at, and 32 entries of (team, raw
  value, normalized score 0–100, rank). Latest complete set per kind serves.
- **Curated Signal Source**: a repo-versioned data file (kind, season,
  source attribution, entries) — the O-line rank origin.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a projection refresh, offensive-potential and SoS
  signals exist for all 32 NFL teams with distinct ranks 1–32.
- **SC-002**: Spot-check plausibility: the consensus top-3 projected
  offenses (by team total projected points) rank in the signal's top 5; a
  consensus bottom-5 offense ranks in its bottom 10.
- **SC-003**: Every projected player's detail shows all four signals (or
  honest dashes) with zero detail-load failures across the test league set.
- **SC-004**: Signal computed-at timestamps track the projection serving
  set's fetch time exactly (same refresh cycle) during draft season.
- **SC-005**: The curated O-line file covers 32/32 teams and its
  completeness check fails loudly (at load, not silently at read) when a
  team is missing.
- **SC-006**: Board and detail response times stay within 002's SC-001
  budget with signals attached.

## Assumptions

- **Derive-don't-fetch** *(ratified in clarification)*: offensive potential
  and defensive strength (the SoS ingredient) are derived from the
  projection data Draft Genie already ingests — team offense = sum of the
  team's offensive players' projected fantasy output; opponent defensive
  strength from D/ST projections — no external sources.
- **SoS weighting** *(ratified in clarification)*: all scheduled weeks
  count; fantasy-playoff weeks 15–17 count double.
- **NFL schedule source**: the same public ESPN team metadata already used
  for byes exposes each team's schedule; no new provider.
- **O-line curation** *(ratified in clarification)*: seeded once per
  preseason from PFF's public offensive line rankings (attribution + date in
  the file), maintained by the repo owner; intentionally not user-editable
  (constitution IV spirit).
- **Team-level granularity in v1**: per-position defensive splits (e.g.
  "defense vs WR") are out of scope until the engine (006) demonstrates a
  need; Boris Chen tiers (003) already carry expert per-player consensus.
- **Signals are global** like projections — computed once, read by every
  league; nothing league-specific in this feature.
