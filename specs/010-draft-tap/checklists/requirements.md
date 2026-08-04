# Specification Quality Checklist: Draft Tap

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-03
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

- Validation pass 1 (2026-08-03, at `/speckit-specify`): claimed all items pass
  and full FR→SC traceability. **That claim was wrong** — see pass 2.
- Validation pass 2 (2026-08-03, after `/speckit-clarify` + adversarial review):
  22 findings survived verification. All items now pass, after substantial
  revision. What the review caught, recorded so the same mistakes are not made a
  third time:
  - **The gate was unenforced.** The constitution's verify-first rule sat only in
    Assumptions, and the capture that discharges it was ranked P4 — which
    `/speckit-tasks` sequences *last*, after the relay it is meant to validate.
    The spec asserted "verified first" while ranking the verifying work last.
    Fixed by promoting discovery to its own P1 gate story with SC-000.
  - **The privacy fix broke the 005 contract.** "Numeric identifiers only"
    accidentally excluded the browser-side observation time, which 005 FR-020a
    uses to distinguish a collapsed batch from a live sequence and 008 needs for
    per-pick timing. Fixed by FR-006b naming it explicitly in scope.
  - **The privacy boundary had a hole at its largest message.** ESPN's full pick
    ledger arrives encoded; relaying it verbatim satisfied FR-005 and passed
    inspection while carrying exactly the identities FR-006a forbids. Fixed by
    FR-006c: filter decoded content, never the wire form.
  - **"Clean by construction" covered the wrong artifact.** It applies to the
    relayed corpus, not to the raw discovery capture — which is unstripped by
    necessity and carries member identifiers, names and chat. That is the same
    defect class as 005's fixture capture. Fixed by FR-019a.
  - Also fixed: latency budget double-claimed with 005 (SC-002 now sits inside
    005's envelope), credential scope described incompatibly by the two specs,
    silent-discard vs loud-report ambiguity on unknown messages, a replay check
    that validated the recording against itself, and six requirements with no
    success criterion.
- Traceability is now asserted **and** checked (SC-015), rather than asserted.
- The spec deliberately names **no** technology: not the script format, not the
  browser API it hooks, not the transport to Draft Genie, not ESPN's message
  verbs. Those belong to `/speckit-plan`, and pinning them now would bake in
  guesses about a protocol this feature's own first task is meant to establish.
- Two ROADMAP open questions are carried as labelled assumptions rather than
  `[NEEDS CLARIFICATION]` markers, matching how 004 and 005 were specified:
  **delivery form** (userscript vs packaged extension) and **browser support**
  (Chrome-only vs wider). Both are flagged for `/speckit-clarify`.
- **The message format is not yet known.** FR-018/FR-019 exist precisely because
  a third-party protocol document and its own source disagree on the meaning of
  a key field. The spec is written so that nothing downstream depends on that
  field's meaning until a real capture settles it — this is the constitutional
  gate-first rule (v1.1.0, Development Workflow) applied deliberately.
- Items marked incomplete require spec updates before `/speckit-clarify` or
  `/speckit-plan`.
