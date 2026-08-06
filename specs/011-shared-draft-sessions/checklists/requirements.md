# Specification Quality Checklist: Shared Draft Sessions

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-06
**Updated**: 2026-08-06 — 012 folded in
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

### One idea, and the defects fall out of it

Six items arrived as separate bug reports and one feature request. Written up
separately they would have been seven unrelated changes. They are not unrelated —
each is the system conflating two things, and the spec states the rules once and
derives requirements from them:

> **1. A draft's frames are LEAGUE-SHARED; a manager's perspective — team,
> settings, preferred list — is PER-ACCOUNT.**
>
> **2. A relay must prove which account it acts for; the user must never hold the
> proof.**

Rule 1 governs receiving, rule 2 sending. That is why FR-002, FR-037 and FR-039
say compatible things rather than three different things, and why FR-022 can say
the credential's *handling* changes without its *existence* being in question.

### The merge with 012 removed a real duplication

012's "make tap state legible" and 011's "make draft-room state legible" were the
**same requirement seen from two screens**. Combining them turned eight user
stories into seven and produced one story (US2) that covers both surfaces with
one rule: every state names its remedy. Kept apart, the two specs would also have
argued about the same boundary — who may send, who may receive, what proves it —
from opposite sides.

### The constraint was never a decision

**No requirement anywhere says frames must not cross accounts.** Delivery is
account-scoped because a session is addressed by connection and season, and that
is where the owner's team id happens to live. The constitution's isolation rule
enumerates *"another user's leagues, credentials, or preferred lists"* — not the
picks in a draft everyone in the room is watching.

This is therefore not "relaxing a security boundary". It is implementing one that
was drawn by accident in the wrong place. The boundary that **is** load-bearing —
the ingest credential — is kept, and the spec says so at length.

### Evidence, not assertion

- **71 vs 1** — batches relayed by a leaguemate versus the owner, same league,
  2026-08-05. The owner received nothing.
- **3 pairings in 14 minutes** — a *working* tap re-paired twice under time
  pressure because its state was not observable.
- **11 vs 12 rounds** — two managers' recorded settings for the same draft, which
  is why FR-005 exists rather than assuming agreement.
- **~72 players** wrongly marked drafted when a completed draft's ledger loaded
  into a fresh session.
- **1 preferred player** destroyed by the only available reset workaround.

### Resolved in `/speckit-clarify` (Session 2026-08-06)

Five questions, all answered. Four of the five carried-forward items are settled;
the fifth was deferred deliberately.

1. **Keep the ingest credential** — ratified with the alternatives explicitly on
   the table. Removing it, and narrowing it to live-draft windows, were both
   rejected. FR-022, and the new **FR-022a** forbids inferring attribution from
   context in place of a credential — the constraint an armed-session or
   live-draft check would rely on is weakest exactly when a draft is live.
2. **Sharing is automatic** — no setting on either side, relayer neither asked
   nor identified (**FR-003a**). The reasoning that decided it: a control that
   must be found will not be found by the managers who need this most, the ones
   who cannot relay at all.
3. **A relay stopping mid-draft** gets one message for everyone, naming the
   remedy (**FR-006a**). The owner chose uniformity over a tailored message, and
   the defence is sound: *"someone needs a draft room open in Chrome"* is
   actionable from an iPad — socially rather than technically.
4. **Enablement survives sign-out**, revocable from the tap page (**FR-020a**).
   Asymmetric failure modes decided it: a stale enablement leaks nothing, while a
   relay dying mid-draft now takes a whole league's feed with it.
5. **Several relays are all accepted and deduplicated** (**FR-007a/b**) rather
   than electing a primary. This question was not on the original list — it was
   added during clarify because US1 *increases* the chance of it: today two
   relays feed two separate sessions, afterwards they feed one league. Failover
   was rejected as a path that would never run until the night it mattered.
   **FR-007b** guards the subtle half: duplicate suppression must not become
   first-writer-wins on a corrected fact.

### Still deferred

- **What binds a ledger to its draft.** FR-024 rules out coverage-alone;
  choosing the replacement needs to know what the frames actually carry, which is
  research for planning rather than a decision the owner can make.
- **Signed in as one account, drafting a league connected under another.**
  Remains an edge case. Low likelihood with one operator; worth resolving in
  planning rather than spending a clarify question on.

### Outstanding

- **US1 is the largest change and touches shipped 005 behaviour.** Correctly P1
  by value, but not a small fix: the session's addressing is the substantial
  work. US2–US7 are each far smaller and independently shippable, so there is a
  viable path that fixes the sharp-edged bugs first and takes US1 carefully.
- **Seven user stories is a lot for one feature.** Justified by a single root
  cause and a single pair of rules, but if planning finds the work does not
  cohere, the split to make is US1 alone versus the rest — **not** back along the
  011/012 line, which was the wrong seam.
