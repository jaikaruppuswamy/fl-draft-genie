# Specification Quality Checklist: Deployment Ops

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

### The spec is grounded in verified state, not assumed state

Every gap in the Overview table was checked against the live configuration
before being written down, not inferred from the roadmap:

- `wrangler.jsonc` — one environment, `*/5 * * * *` cron, `observability.enabled`
  true, **no logpush**
- `wrangler secret list` — exactly two secrets (`CREDENTIAL_KEY`,
  `SESSION_SECRET`)
- No `.github/workflows` — **no CI at all**, on a public repo
- No notification code anywhere in `src/`
- `README.md` — local dev and workflow only, no operational content

Naming shipped artifacts is evidence about constraints, not prescription; the
same style 006, 007 and 008 used. Every FR and SC is stated as an outcome.

### The framing is a finding, not a restatement of the roadmap

ROADMAP 009 lists "logging and alerting, backups, a runbook". Writing it that
way would have produced a generic ops checklist. Reviewing what has actually
gone wrong across nine features gave a sharper thesis: **nothing in this project
has failed loudly.** Five of six real defects were silent and found by accident,
the shortest after days. So US1 is about *noticing*, and SC-003 targets the
metric that has actually hurt — the archive wrote nothing for a month and looked
healthy.

### Carried forward to `/speckit-clarify`

Deliberate defaults, recorded so they are not mistaken for settled decisions:

1. **Single environment retained** — flagged in Assumptions as the one most
   likely to be overturned, and stated so it can be argued with. A staging
   environment is the obvious ask; the counter-argument is Principle VIII and
   one operator.
2. **Email as the alert channel** — reuses the only delivery the product has.
   Shared fate with sign-in mail is recorded as an edge case, not solved.
3. **Platform point-in-time recovery** rather than an export pipeline.
4. **Alert thresholds** — FR-002 requires "repeatedly" and FR-006 requires
   bounded repetition, without fixing numbers. Clarify or plan should pin them;
   they are cheap to change and expensive to get noisily wrong.

### Outstanding

- **FR-021 reaches into 002.** Reconciling the prune with 002's ratified
  retention decision is the one requirement here that changes another feature's
  shipped behaviour. Deliberate — the contradiction is recorded in ROADMAP and
  needs an owner — but worth flagging as a scope edge before planning.

### Re-validated 2026-08-08

Two real drafts and five shipped features later, every checklist item above
still passes. The gap table was re-checked against the live configuration rather
than assumed: still no `.github/workflows`, still one environment, still no
logpush, still no notification code beyond the sign-in mailer.

Three facts had gone stale and were corrected in `spec.md`:

1. **`draft_archives` writes now** — two rows, one per real draft. US1's
   headline example is no longer a live defect. The requirement is untouched:
   nothing reported the silence and nothing reported the repair either, which is
   the same argument with a better ending.
2. **Test counts** — 993 + 80 became 1,132 + 182.
3. **US3's iPad premise was wrong, and this is the one that mattered.** The spec
   asked the runbook to record "desktop Chrome only; no live monitoring from an
   iPad" as a documented limitation. The 2026-08-06/07 drafts disproved it — the
   room's live-update path read a field the frames do not carry, and desktop
   Chrome froze identically. Planning from that sentence would have written a
   wrong diagnosis into the one document meant to be trusted under time
   pressure. Replaced with FR-016a: a limitation must be demonstrated, and
   scoped to the half of the product it constrains.

The third is worth dwelling on, because it is this feature's own thesis turned
on itself. A spec is a place a wrong belief can go unnoticed for months, and
this one survived because nobody re-read it against reality until the reality
had changed. **The same failure mode 009 exists to fix applies to 009.**

`011-shared-draft-sessions` shipped after this spec was written and was added to
Dependencies: fan-out means one tap serves managers who are not running it, so
"the tap stopped" is no longer a fact about the person being alerted.
