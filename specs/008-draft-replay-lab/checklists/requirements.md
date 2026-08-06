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

### Resolved in `/speckit-clarify` (Session 2026-08-05)

All four items previously carried forward are now settled, plus one that was not
on the list. Re-validated against the updated spec: **16/16 still passing.**

1. **What "the engine did well" means** — behavioural measures now, actual
   season points once a season is played, and no projection-derived number ever
   reported as evidence (FR-017, FR-017a).
2. **CLI harness vs shipped UI** — CLI, ratified (FR-035 – FR-038).
3. **Corpus location** — committed fixtures, with an explicit admission step
   (FR-036, FR-037).
4. **Opponent model** — still ADP with bounded, seeded noise, but no longer a
   bare assumption: FR-020c requires it be characterised against real
   drafter-versus-ADP behaviour drawn from pick-sequence-only entries.

Three findings during clarify materially changed the spec and are worth
recording, since none was visible from the roadmap:

- **The corpus had a built-in expiry.** `pruneSets()` deletes prior-season
  projection sets on every maintenance cron, so the only replayable draft would
  have stopped being replayable in January. Resolved by snapshotting inputs into
  the entry (FR-019a – FR-019d), which also closes the signal-history gap.
- **The archive path is not a viable source.** Zero rows in production, gated on
  two unfinished 005 items. Corpus entries are built from retained relay frames
  instead (FR-019e – FR-019g), removing the dependency entirely.
- **The captured drafts are test runs, not real league drafts** (owner). They
  are retained as harness fixtures and excluded from every rule-set comparison
  (FR-027a – FR-027d). The evidential corpus is therefore empty today.

### Outstanding

- **The evidential corpus is empty.** Not a spec defect — the spec states it and
  requires the lab to say so rather than compare over test entries (FR-027d,
  SC-010) — but it does mean SC-001's ten-draft target is a scaling goal, and
  the first real evidence arrives with the first real 2026 league draft.
