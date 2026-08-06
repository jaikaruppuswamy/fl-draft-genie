# Specification Quality Checklist: Draft Replay Lab

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

### On "no implementation details" — read before objecting

The Overview, Edge Cases and Dependencies sections name shipped artifacts
(`draft_archives`, `signal_entries`, `src/engine/constants.ts`, the 72-frame tap
corpus). These are **evidence about constraints that already exist**, not
prescriptions for how this feature is built — the same style 006 and 007 used
when their specs cited `/design/draft` and 005's event model. Every FR and every
SC is stated as behaviour.

Two of them are load-bearing and would be dishonest to omit:

- **`signal_entries` has no history** (keyed by kind and team, overwritten in
  place). This is why FR-015/FR-016 exist at all. A spec that said "replay
  reconstructs the engine's inputs" without this would specify something
  impossible.
- **`draft_archives` has zero rows in production.** This is why US3 (import)
  exists rather than being deferred, and why US1/US2 are scoped to be buildable
  against the single draft already captured.

### Iterations

One pass, two amendments after the first validation read:

- **FR-012** originally said orderings moved "beyond a stated threshold" without
  requiring the threshold be reported. Untestable as written — a reader could
  not distinguish an unchanged turn from one that moved below the bar. Now the
  comparison must state its own threshold.
- **SC-008** originally read "identical with the lab present and absent", which
  names no way to check it. Restated as reachability plus a before/after
  reproduction of the existing draft-day measurements.

### Carried forward to `/speckit-clarify`

Not defects — deliberate defaults recorded in Assumptions, each of which clarify
should ratify or overturn. They are listed here so they are not mistaken for
settled decisions during planning:

1. **CLI harness vs shipped UI** — ROADMAP's open question, answered CLI
   provisionally on Principle VIII grounds.
2. **What "the engine did well" means** — ROADMAP's open question. The spec
   commits to actual season points as the metric of record and states that no
   such data exists yet for 2026, so early runs report behavioural measures
   only. This is the most consequential open item in the feature: pick the wrong
   metric and every tuning session after it optimises the wrong thing.
3. **Opponent model** — ADP with bounded, seeded noise. ROADMAP asks "pure ADP
   with noise?" and the spec says yes, provisionally.
4. **Corpus location** — repository fixtures rather than production data, so a
   comparison is reviewable in a diff.
