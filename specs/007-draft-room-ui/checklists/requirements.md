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

- [ ] No [NEEDS CLARIFICATION] markers remain — **2 open, both from ROADMAP; see below**
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

The two open markers are both **layout and interaction** questions carried
forward from ROADMAP, and both are genuinely product judgements rather than
technical ones:

1. **Full board versus focus mode.** The ratified design shows a full grid, but
   the device is an iPad at arm's length during the one hour that matters.
   Guessing wrong makes the primary live layout wrong.
2. **On-deck / on-the-clock alerting.** Worth asking rather than defaulting
   because the situation that most needs an alert — this screen backgrounded
   while the tap runs elsewhere — is exactly the situation a browser is least
   able to deliver one in. A default of "visual only" would quietly abandon the
   case the feature exists for.

ROADMAP's third open question for 007 — whether preferred lists are per-league
or shared — is **closed**, resolved by 006 (per league connection and season)
and recorded in Assumptions rather than re-asked.

### One contradiction surfaced, not resolved here

006's `contracts/api.md` §1a says consumers must request on the on-deck signal
and **never** on the clock. 005's event model documents that at a snake
turnaround the on-deck signal for the owner's second consecutive pick cannot
exist. FR-004 states the correct behaviour; the **contract wording in 006 needs
amending**, which is a documentation fix outside this spec's own scope but must
not be forgotten. Recorded in Dependencies.

### Known-untested territory, stated rather than assumed

Draft-end detection, the archive write and the keeper path have never run against
real data together — production holds zero archived drafts. FR-022 requires the
screen handle completion arriving *and* never arriving, because neither has been
observed.
