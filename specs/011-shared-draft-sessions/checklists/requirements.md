# Specification Quality Checklist: Shared Draft Sessions

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-06
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

### The spec has one idea, and five defects fall out of it

The five items arrived as a list of bugs. Writing them up separately would have
produced five unrelated fixes. They are not unrelated — every one is the system
conflating two things:

> **A draft's frames are LEAGUE-SHARED. A manager's perspective — team, league
> settings, preferred list — is PER-ACCOUNT.**

Delivery (1) shares neither. The stale ledger (3) treats one draft's frames as
another's. The lab (5) excluded a leaguemate's frames when it should have
excluded only their perspective. Stating the rule once and deriving the
requirements from it is why FR-002, FR-022 and FR-024 say compatible things
rather than three different things.

### The constraint was never a decision

Worth recording, because it changes how the change should be judged: **no
requirement anywhere says frames must not cross accounts.** Delivery is
account-scoped because the session is addressed by connection and season, and
that is where the owner's team id happens to live. The constitution's isolation
rule enumerates *"another user's leagues, credentials, or preferred lists"* —
not the picks in a draft everyone in the room is watching.

So this is not "relaxing a security boundary". It is implementing a boundary
that was drawn by accident in the wrong place.

### Evidence, not assertion

- **71 vs 1** — batches relayed by a leaguemate versus the owner in the same
  league on 2026-08-05. The owner received nothing.
- **11 vs 12 rounds** — two managers' recorded settings for the same draft,
  which is why FR-005 exists rather than assuming agreement.
- **~72 players** wrongly marked drafted when a completed draft's ledger loaded
  into a fresh session.
- **1 preferred player** destroyed by the only available reset workaround.

### Carried forward to `/speckit-clarify`

1. **Consent to relay** — the spec assumes sharing is automatic within a league.
   Consent to *receive* is unnecessary (the picks are already visible to
   everyone in the room); consent for one's tap to *serve* others is the sharper
   question and the assumption most likely to be overturned.
2. **What binds a ledger to its draft** — deliberately left open. FR-013 rules
   out coverage-alone; choosing the replacement is a design question for
   planning.
3. **Whether reset is per-session or per-league**, and whether it needs an audit
   trail.
4. **Duplicate relays** — treated as an edge case that must not corrupt, not as
   a resilience feature. Clarify may want more.

### Outstanding

- **US1 is the largest change and touches shipped 005 behaviour.** It is
  correctly P1 by value, but it is not a small fix, and the plan should expect
  the session's addressing to be the substantial part of the work. US2–US5 are
  each far smaller and independently shippable.
