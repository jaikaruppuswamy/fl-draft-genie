# Specification Quality Checklist: Draft Monitor

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-02
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

- Validation pass 1 (2026-08-02, at `/speckit-specify`): all items pass.
- Validation pass 2 (2026-08-02, after `/speckit-clarify`): all items still
  pass. Five clarifications were ratified — live poll cadence, unattended
  behavior, format scope, the visible surface, and retention — and integrated
  into FR-006/FR-006a, FR-007/FR-007a, FR-013, FR-025, SC-001/SC-001a,
  SC-009a and SC-010a. The two ROADMAP open questions previously carried as
  labelled assumptions (draft-type scope, poll cadence) are now ratified
  decisions, not assumptions.
- An adversarial review pass over the clarified spec raised 20 candidate
  defects across five lenses. Nine were acted on: batched-observation event
  semantics (FR-020a, SC-003 — four lenses converged on this one), the owner's
  full remaining pick schedule for 006 (FR-010), replay-sufficient retention
  for 008 (FR-013), unattended session recovery (FR-014a, SC-005), credential
  handling in long-lived sessions (FR-024a), session keying terminology
  (FR-001), rosters on the diagnostic page (FR-025), an offline fixture for the
  replay check (SC-010), and the ordinal-fields tension in SC-009a.
- Clarify round 2 (2026-08-02, after `/speckit-analyze`): all items still pass.
  Three spec-level defects the analysis found are now ratified rather than
  contradictory — FR-020's unconditional "two picks ahead" became an ordinal
  guarantee carrying the real `picks_until` (0 is legal at snake round turns);
  FR-019's exactly-once is now scoped **per revision**, reconciling it with
  FR-012's correction replay; and SC-001/SC-001a moved from an absolute 100% to
  a 95th percentile plus a tier+60 s ceiling, which is the first version of that
  criterion the platform can actually satisfy. T048 now measures it — before
  this round, the feature's headline latency number was asserted nowhere.
- Two consistency fixes applied in the same pass, not from a question: `aborted`
  was missing from the Draft Session status list while FR-024 named it, and the
  Draft Event entity did not carry `revision`.
- **Clarify round 3 (2026-08-03, after Gate 0 failed)**: the spec's data source
  was disproved, not merely underspecified. ESPN writes the draft to its league
  database once, at completion, so the polling mechanism ratified in round 1 is
  withdrawn. Four decisions ratified: picks arrive by **ingest from a browser
  tap**; the tap is its own feature (`010-draft-tap`) sequenced **before** 005;
  mid-draft rebuild replays a **persisted frame log** reconciled against ESPN's
  full pick ledger; and a session receiving no frames reports **not receiving
  picks** rather than presenting a stale board.
- Two checklist items are consequently **provisional**: "Requirements are
  testable and unambiguous" and "Feature meets measurable outcomes" now depend
  on a frame contract that `010-draft-tap` has not yet produced. They pass
  against the spec as written, but SC-001's latency budget is an estimate from
  third-party captures rather than a measurement, and the `SELECTED` field-1
  ambiguity must be settled before any reconciler is built on it.
- `plan.md`, `tasks.md`, `data-model.md` and `contracts/api.md` were authored
  against the polling design and are **stale**. They need `/speckit-plan` after
  the tap lands — the spec is the only artifact updated in this round.
- Transport ("push over a persistent connection", Durable-Object-per-draft-room)
  is a decision already ratified in 001 and referenced, not re-specified here;
  requirements themselves (FR-015–FR-017) stay transport-agnostic. Cadence
  values are stated because they are ratified product behavior, not because the
  spec is prescribing an implementation.
- Items marked incomplete require spec updates before `/speckit-plan`.
