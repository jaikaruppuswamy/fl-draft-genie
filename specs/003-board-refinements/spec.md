> ## ⚠️ TIERING REMOVED (2026-08-07)
>
> FR-002, FR-003 and FR-004 — positional tiers from Boris Chen's public feeds —
> were **removed at the owner's decision**. The spec below is kept as the record
> of what was built and why; it no longer describes the product.
>
> Two things decided it. A player absent from the feed rendered beneath the last
> tier heading, so "the source has no opinion" and "worst tier" were
> indistinguishable on screen — reported as *"Lamar is in tier 8"* when he was
> not tiered at all. And the QB feed was ranking Philip Rivers, retired since
> 2020, while omitting Lamar Jackson, Patrick Mahomes and Jayden Daniels;
> verified against the live feed, with the other positions correct.
>
> The owner's judgement was that the grouping was confusing **even where the
> data was good**. The board now orders by projected points, which every other
> surface already uses.
>
> Removed in `016`: `src/tiers/`, `src/db/tiers.ts`, the `tier` field on the
> board response, the board's grouping and column, and the `tier_entries` table
> (`migrations/0013_drop_tiers.sql`). Restoring it means reverting that commit
> and re-applying `migrations/0003_tiers.sql`.

# Feature Specification: Board Refinements

**Feature Branch**: `003-board-refinements`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "Fix minor board issues: (1) player detail lists all stats including unavailable ones — hide them; (2) add player tiering from a reliable source; (3) center align the header in the player board."

## Clarifications

### Session 2026-08-02

- Q: Which tier source? → A: Boris Chen tiers (borischen.co — clustered FantasyPros expert consensus), free public per-position/per-format feeds, matched to each league's scoring format.
- Q: Which header centers? → A: The table column headers (PLAYER/POS/…/PROJ PTS), not the page title.
- Q: How hidden should unavailable stats be? → A: Only projected categories listed, plus one count note ("N league categories not covered by projections") — clutter gone, honesty kept (constitution VII).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Streamlined projection detail (Priority: P1)

Opening a player's projection detail shows only the categories the projection
actually covers. Categories the league scores but the source doesn't project
are no longer listed as rows; instead a single quiet note reports how many
were omitted (e.g., "4 league categories not covered by projections"). This
amends 002's display of zero-rows (002 FR-009's *identifiability* is
preserved by the note; the API contract is unchanged).

**Why this priority**: The user-reported papercut — for skill players, most
of a long league scoring list is irrelevant noise (kicking stats for an RB).

**Independent Test**: Open an RB's detail in a league that scores kicking:
no kicker rows appear, the note counts them, visible rows still sum to the
total (within the rounding rule).

**Acceptance Scenarios**:

1. **Given** a projected player, **When** their detail opens, **Then** only
   covered categories are listed and each multiplies out as before.
2. **Given** a league scoring N categories of which K are uncovered for that
   player, **When** the detail opens, **Then** exactly N−K rows show and the
   note reads "K league categories not covered by projections" (note absent
   when K = 0).
3. **Given** an unprojected player, **When** their detail opens, **Then** the
   existing "no projection" state shows (unchanged).

---

### User Story 2 - Player tiers (Priority: P2)

The player board shows each projected player's **tier** — sourced from Boris
Chen's positional tiers (clustered expert consensus), using the tier set
matching the league's scoring format (PPR / half-PPR / standard). When a
position filter is active, tier boundaries are visible as groupings. Tiers
refresh alongside projections. Players the source doesn't tier simply show
no tier.

**Why this priority**: Tiers are how drafters compare across ADP and
projections — "last player in tier 2" beats "ranked 14th" for decisions.

**Independent Test**: Filter the board to RB in a PPR league: each projected
RB shows a tier number consistent with Boris Chen's current PPR RB tiers;
tier group boundaries render; a deep unranked player shows a dash.

**Acceptance Scenarios**:

1. **Given** tiers were fetched for the league's scoring format, **When**
   the board is viewed, **Then** projected players display their positional
   tier number.
2. **Given** a position filter is active, **When** the list renders, **Then**
   players are visually grouped by tier with labeled boundaries.
3. **Given** a player the source doesn't list (name mismatch or deep player),
   **When** the board renders, **Then** the player shows no tier and nothing
   breaks.
4. **Given** the tier source is unreachable at refresh, **When** the board
   renders, **Then** the last-fetched tiers keep serving (labeled by the
   overall freshness), and with no tiers ever fetched the board renders
   tierless.
5. **Given** two leagues with different scoring formats, **When** each board
   renders, **Then** each uses the tier set matching its own format.

---

### User Story 3 - Centered column headers (Priority: P3)

The player board's table column headers are center-aligned over their
columns.

**Independent Test**: Visual — each column label sits centered above its
column on the board page.

**Acceptance Scenario**: **Given** the board page, **When** it renders,
**Then** the column header labels are center-aligned (data cell alignment
unchanged).

---

### Edge Cases

- Name mismatches between the tier source and ESPN (punctuation, suffixes
  like Jr./III, diacritics, D/ST naming): normalized matching; unmatched
  players are tierless, never mis-tiered; match rate is observable in logs.
- The tier source changes its file format: the parser fails safe → previous
  tiers keep serving; failure logged.
- Leagues with exotic reception scoring (e.g., 2 pt/rec): map to the nearest
  standard format (≥0.75 → PPR, 0.25–0.74 → half, else standard).
- FLEX filter: tier shown is the player's positional tier (no separate FLEX
  tier groupings in v1).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The projection detail MUST display only covered categories,
  with a count note for omitted uncovered categories (absent when none);
  visible rows continue to sum to the total per the 002 rounding rule. The
  002 API contract is unchanged (display-layer behavior).
- **FR-002**: The system MUST ingest positional tiers from Boris Chen's
  public feeds for the PPR, half-PPR, and standard formats, refreshed with
  the same cadence events as projections; a failed fetch keeps the previous
  tiers (all-or-nothing per format+position feed).
- **FR-003**: Tier–player matching MUST use normalized names (case,
  punctuation, suffixes, diacritics) plus position; unmatched players carry
  no tier. The refresh MUST log the match rate.
- **FR-004**: The board MUST show each projected player's tier for the
  league's scoring format (reception-value mapping: ≥0.75 PPR, 0.25–0.74
  half, else standard), and MUST group by tier with labeled boundaries when
  a single-position filter is active.
- **FR-005**: The board's table column headers MUST be center-aligned.

### Key Entities

- **Tier Set** *(new, global)*: tiers for one (scoring format, position)
  pair from one successful fetch: source, format, position, fetched-at, and
  entries of (normalized player name, tier number). Latest complete fetch
  per (format, position) serves.

## Success Criteria *(mandatory)*

- **SC-001**: An RB's detail in a league scoring kicking shows zero kicker
  rows and a correct omitted-count note; visible rows sum to the total.
- **SC-002**: ≥ 85% of the board's top-100 projected players carry a tier
  (match-rate check against the live source).
- **SC-003**: In a PPR league, spot-checked players' tiers equal the
  source's current PPR tiers for their position.
- **SC-004**: Tier data refreshes without user action on the projection
  cadence; a dead tier source never breaks the board.
- **SC-005**: Column headers render centered on desktop and iPad widths.

## Assumptions

- Boris Chen's draft-season positional text feeds remain publicly
  accessible; exact URLs/format verified at implementation behind a single
  source module (same pattern as the ESPN source).
- Tiers apply to QB/RB/WR/TE (and K/DST only if the source provides them);
  positions without feeds are tierless.
- Tier numbers are per-position (RB tier 2 ≠ WR tier 2); no cross-position
  tier math in this feature (that's 005's job).
