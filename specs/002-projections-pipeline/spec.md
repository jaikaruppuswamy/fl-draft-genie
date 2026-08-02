# Feature Specification: Projections Pipeline

**Feature Branch**: `002-projections-pipeline`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "002" (ROADMAP.md feature 002 — projections-pipeline: the player universe and season projections, re-scored per league)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse my league's player board (Priority: P1)

A manager with a connected league opens that league's player board and sees
every draftable NFL player with a season projection **in that league's own
scoring** (constitution III): projected points, position, NFL team, bye week,
and average draft position (ADP). The board is sorted by projected points by
default, filterable by position, and searchable by player name.

**Why this priority**: The board is the product's first look at "who is worth
what, in my league" — the raw material every later feature (recommendations,
draft room, preferred lists) consumes. It is independently valuable as a
draft-prep cheat sheet.

**Independent Test**: With one connected league, open its board and verify a
well-known player shows projected points, position, team, bye, and ADP; filter
to RB-only; search a name; confirm default ordering is by projected points
descending.

**Acceptance Scenarios**:

1. **Given** a connected league with synced scoring settings, **When** the
   user opens its player board, **Then** they see a list of draftable players
   with projected season points, position, NFL team, bye week, and ADP,
   sorted by projected points descending.
2. **Given** the board is open, **When** the user filters by a position
   (e.g., RB), **Then** only players eligible at that position are listed and
   the ordering within the filter remains by projected points.
3. **Given** the board is open, **When** the user searches part of a player's
   name, **Then** matching players appear regardless of position filter
   state being cleared or kept (search composes with the filter).
4. **Given** two connected leagues whose scoring differs (e.g., PPR vs
   standard), **When** the user views each league's board, **Then** the same
   player shows different projected point totals reflecting each league's
   scoring rules.
5. **Given** a league whose scoring includes a stat category ESPN projections
   don't cover, **When** the board is shown, **Then** players are still
   listed and the uncovered category simply contributes no points (surfaced
   in the projection detail, per User Story 3).

---

### User Story 2 - Projections stay fresh (Priority: P2)

ESPN updates its projections continually through the preseason (injuries,
depth-chart changes, holdouts). Draft Genie refreshes the player universe and
projections automatically on a regular schedule during draft season, and any
user can trigger an on-demand refresh. The board always shows when its data
was last updated.

**Why this priority**: Stale projections quietly poison every downstream
number. But a manually-refreshed board is workable for a short time, so this
lands after the board itself.

**Independent Test**: Trigger a manual refresh and confirm the "last updated"
timestamp advances; verify the scheduled refresh runs without user action
(observable by the timestamp advancing on its own within the scheduled
interval).

**Acceptance Scenarios**:

1. **Given** projections were fetched some time ago, **When** the scheduled
   refresh interval elapses, **Then** projections and player data are
   re-fetched without any user action and the board reflects the update.
2. **Given** a user viewing the board, **When** they trigger "refresh
   projections", **Then** fresh data is fetched and the last-updated
   timestamp advances.
3. **Given** the projection source is unreachable during a refresh, **When**
   the refresh fails, **Then** the previous projections remain available,
   labeled with their age, and no partial update is shown (all-or-nothing
   per refresh).
4. **Given** projections were refreshed, **When** a league's board is viewed,
   **Then** projected points reflect the new stat lines re-scored in that
   league's currency without any additional per-league action.

---

### User Story 3 - See why a projection is what it is (Priority: P3)

Tapping a player on the board opens a projection detail: the projected stat
line (passing yards, rushing TDs, receptions, …) alongside the league's point
value for each category and the resulting points per category, summing to the
total. Categories the league scores but the projection doesn't cover are
listed as contributing zero.

**Why this priority**: Explainability is a constitutional principle (VII) and
builds trust in the numbers before the recommendation engine exists — but the
board is useful without it.

**Independent Test**: Open a player's detail in a PPR league and verify
receptions × 1.0 appears as its own line, the per-category products sum to
the displayed total, and the same player in a non-PPR league shows no
reception points.

**Acceptance Scenarios**:

1. **Given** a player with a projection, **When** the user opens their
   detail from a league's board, **Then** each projected stat category is
   shown with the projected amount, the league's per-unit value, and the
   resulting points, and the categories sum to the player's total.
2. **Given** a league scoring category with no projected stat (e.g., a
   custom bonus), **When** the detail is shown, **Then** that category
   appears with zero contribution and a note that the projection source
   doesn't cover it.

---

### Edge Cases

- Players without projections (deep rookies, practice-squad, just-signed):
  they remain in the universe and are listed at the bottom of the board,
  clearly marked "no projection", never blocking or erroring the board.
- Multi-position-eligible players (e.g., RB/WR): the player appears under
  each eligible position filter, with one canonical primary position shown.
- A player traded or released mid-preseason: the next refresh updates the
  NFL team and bye week; no stale-team ghost entries.
- Retired or inactive players: excluded from the default board.
- Leagues scoring individual defensive players (IDP): the board still works
  for offense/K/D-ST; IDP-specific positions appear only if the projection
  source covers them, otherwise those slots' players show "no projection"
  (partial support, surfaced honestly).
- A league connected *after* the latest projection refresh: its board is
  computable immediately from stored data (no per-league fetch needed).
- Duplicate names (two players named alike): disambiguated by team/position
  in board and search results.
- Refresh during a live draft window: must not degrade or lock the board.

## Requirements *(mandatory)*

### Functional Requirements

**Player universe**

- **FR-001**: The system MUST maintain a universe of NFL players relevant to
  fantasy football — for each: full name, primary position, all eligible
  positions, NFL team, bye week, and active/inactive status.
- **FR-002**: The system MUST include team defenses (D/ST) and kickers as
  draftable entries wherever the projection source provides them.
- **FR-003**: The system MUST exclude inactive/retired players from default
  board views while retaining them in storage (they may still be rostered in
  a league).

**Projections**

- **FR-004**: The system MUST ingest season-long projections as per-category
  stat lines (not just pre-scored totals), preserving every projected stat
  category losslessly.
- **FR-005**: The system MUST store each player's ADP (average draft
  position) and the source's overall rank where available.
- **FR-006**: The system MUST record when projections were last successfully
  refreshed, and display that freshness wherever projections are shown.
- **FR-007**: Projections and the player universe MUST be stored once,
  globally — not per league; league-specific numbers are derived at read
  time (or cached) from the global data plus the league's scoring rules.

**League-currency scoring (constitution III)**

- **FR-008**: The system MUST compute each player's projected points for a
  given league by applying that league's synced scoring rules (from feature
  001's lossless scoring map) to the projected stat line: sum over
  categories of (projected amount × league points per unit).
- **FR-009**: Scoring categories a league defines that the projection source
  does not cover MUST contribute zero points and MUST be identifiable as
  uncovered in the projection detail.
- **FR-010**: A change to a league's scoring settings (via 001 re-sync) MUST
  be reflected in that league's projected points without waiting for the
  next projection refresh.

**Board & detail**

- **FR-011**: The system MUST provide, for any connected league, a player
  board listing draftable players with projected points (league currency),
  primary position, NFL team, bye week, and ADP, sorted by projected points
  descending by default.
- **FR-012**: The board MUST support filtering by position (including FLEX-
  eligible groupings the league uses) and searching by player name, composably.
- **FR-013**: Players without projections MUST appear at the bottom of the
  board marked as unprojected rather than being hidden or erroring.
- **FR-014**: The system MUST provide a per-player projection detail for a
  given league: each projected stat category with projected amount, the
  league's per-unit point value, the resulting category points, and the
  total (FR-008's sum), including zero-contribution uncovered categories.

**Refresh**

- **FR-015**: The system MUST refresh the player universe and projections
  automatically on a schedule — at least daily during draft season (August–
  September) — without user action.
- **FR-016**: Any signed-in user MUST be able to trigger an on-demand global
  refresh, rate-limited to prevent hammering the source.
- **FR-017**: A failed refresh MUST leave the previous projection set fully
  intact and labeled with its age; partial updates MUST NOT be exposed
  (all-or-nothing per refresh cycle).

### Key Entities

- **Player**: One NFL player (or D/ST unit). Attributes: source player id,
  full name, primary position, eligible positions, NFL team, bye week,
  active status.
- **Projection Set**: One successfully completed refresh of season
  projections: fetch timestamp, season, source identifier, and status. The
  latest complete set is the serving set.
- **Player Projection**: A player's projected season stat line within a
  projection set: map of stat category → projected amount, plus ADP and
  overall rank where available.
- **League Board Entry** *(derived, not stored source data)*: a player's
  projected points in one league's currency — computed from Player
  Projection × the league's scoring map (001's League Settings Snapshot).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a connected league, the board shows at least 300 projected
  players and loads in under 2 seconds on a normal broadband connection.
- **SC-002**: For 10 sampled players across 3 leagues with different scoring,
  the displayed projected points equal a hand calculation from the projected
  stat line and the league's scoring rules to within 0.1 points.
- **SC-003**: The same player shows different projected totals in two
  leagues whose scoring differs in a category the player is projected in —
  verified for at least a PPR/non-PPR pair.
- **SC-004**: During August–September, projections refresh without user
  action at least once per 24 hours, and the board's freshness label never
  shows data older than 25 hours while the source is reachable.
- **SC-005**: A user can go from the dashboard to finding a specific
  player's projected points in their league in under 15 seconds (open board,
  search, read).
- **SC-006**: Zero board-load failures caused by unprojected players,
  uncovered scoring categories, or multi-position players across the test
  league set.

## Assumptions

- **ESPN is the sole projection source** for this feature (owner's guidance:
  use ESPN if simplest; constitution VIII). The design keeps the source
  behind a single boundary so an alternative source is a future feature,
  not a rewrite.
- **Season-long projections only**: weekly projections and in-season
  updates are out of scope (relevant later for start/sit features, not
  drafting).
- **ADP comes from the same source** as projections; if unavailable for a
  player, the board shows a dash rather than a synthetic value.
- **Draftable universe** means offense skill positions + K + D/ST as covered
  by the source; IDP coverage is partial-if-available (edge case above).
- **Refresh cadence default**: daily during August–September, weekly
  otherwise; on-demand refresh available year-round. Exact cadence is
  debatable in `/speckit-clarify`.
- **The board lives inside the existing app** as a per-league page reachable
  from the league detail (001's UI), using the ratified Organic design
  system.
- **No draft-state awareness yet**: the board does not know who is already
  drafted (that arrives with 004/005); it is a pure projection view.
