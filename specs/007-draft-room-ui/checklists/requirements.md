# Specification Quality Checklist: Draft Room UI

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain — **both resolved in clarify, 2026-08-05**
- [X] Requirements are testable and unambiguous
- [X] Success criteria are measurable
- [X] Success criteria are technology-agnostic (no implementation details)
- [X] All acceptance scenarios are defined
- [X] Edge cases are identified
- [X] Scope is clearly bounded
- [X] Dependencies and assumptions identified

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
- [X] User scenarios cover primary flows
- [X] Feature meets measurable outcomes defined in Success Criteria
- [X] No implementation details leak into specification

## Notes

Both original markers are resolved (see spec.md § Clarifications, Session
2026-08-05), and one of them turned out not to need a decision at all:

1. **Full board versus focus mode** → **settled by the ratified design**, not by
   a judgement call. `/design/draft` is already a two-column layout — full grid
   plus a fixed 318px rail. Reading it closed the question and surfaced a better
   one in its place: the rail has room for about one line per player, while 006
   emits up to eight signed adjustments. FR-006 / FR-006a split that — headline
   reason always visible, full breakdown one interaction away.
2. **On-deck / on-the-clock alerting** → **visual only** (FR-023), with FR-023a
   stating plainly that it reaches the owner only while they are looking at the
   screen. That limitation is recorded rather than papered over.

Three further decisions were taken in the same session, none of which were in
the original markers:

3. **SC-001 is verified offline** (FR-024), by replaying the archived draft at
   its real per-pick timing. This is the headline criterion, and it was
   explicitly unverifiable in 006. Leaving it to draft day would have been the
   fourth instance of this project shipping something marked done that nothing
   had exercised.
4. **The recommendation refreshes on every pick** (FR-003), which makes
   readiness a property of the design rather than of catching one moment.
5. **Completion is concluded from either route** (FR-022), because the
   completion signal has never fired in production.

### The contract correction, now with a second reason

The spec already recorded that 006's `contracts/api.md` §1a ("request on
`on_deck`, never on `on_the_clock`") is impossible to honour at a snake
turnaround. Clarification found a second, larger problem: it **prescribes a
mechanism where it meant an outcome**. FR-003's refresh-every-pick satisfies
006's actual intent far more robustly than any single trigger. 006's contract
should be restated as the outcome — *the recommendation must be current when the
owner's turn begins* — before it pushes a future consumer toward the fragile
design. Recorded in Dependencies; it is a documentation fix outside this spec's
own scope, and must not be forgotten.

### Still-untested territory, stated rather than assumed

Draft-end detection, the archive write and the keeper path have never run
against real data together — production holds zero archived drafts. FR-022a/b
respond to that by refusing to let either completion route be load-bearing
alone, and by making a disagreement between them **visible** rather than
resolved silently: that divergence will be the first real evidence about which
route to trust.
