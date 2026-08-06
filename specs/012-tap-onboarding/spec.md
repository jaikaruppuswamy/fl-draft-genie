# Feature Specification: Tap Onboarding — ❌ CANCELLED

**Feature Branch**: `012-tap-onboarding` *(deleted; never merged, never pushed)*

**Created**: 2026-08-06

**Status**: **CANCELLED — merged into [011-shared-draft-sessions](../011-shared-draft-sessions/spec.md) the same day**

## Why this number is retired rather than reused

012 was specified separately by mistake and folded into 011 within the hour. The
directory is kept, and the number is **not** reused, so that a reference to "012"
anywhere resolves to this note instead of silently pointing at a different
feature. Directory numbers are identifiers in this project, not a queue.

## Why it should never have been separate

012 covered simplifying tap setup: install the userscript, acknowledge once, and
strip the pairing instructions from the Draft Tap page. 011 covered who may
*receive* a draft's frames.

Those are one sentence — ***nobody should have to pair anything*** — split down
the middle:

- **011 removed pairing for receiving**: frames are league-shared, authenticated
  by ordinary sign-in and authorised by league membership.
- **012 removed the user-visible part of relaying**: the credential stays, the
  user stops handling it.

Kept apart, the two specs would have argued about the same boundary — who may
send, who may receive, and what proves it — from opposite sides, and drifted.
Worse, 012's US2 (make tap state legible) and 011's US2 (make draft-room state
legible) were the *same requirement* seen from two screens; combining them turned
eight user stories into seven and removed a genuine duplication.

## What carried over

Everything. Nothing from 012 was dropped in the merge:

| 012 | Now |
|---|---|
| US1 — one-step enablement | 011 **US3**, FR-016 – FR-022 |
| US2 — tap state legible | merged into 011 **US2** with the draft room's states |
| US3 — simplify the page | 011 **US6**, FR-032 – FR-035 |
| The security argument for keeping a credential | 011 Overview, "Why rule 2 keeps a credential" |
| The rejected no-credential alternative | 011 Assumptions, stated verbatim so it can be chosen deliberately |

The argument worth preserving, in one line: **removing the ingest credential
would make it an unauthenticated public write endpoint**, letting anyone who
learned a league identifier inject fabricated picks into a live draft while
everything looked normal. 010 sized its blast radius precisely *because* the
credential names an account. 011 keeps it and takes the user out of handling it.

## Governance

No code, plan or tasks were produced under 012. Its branch was deleted unmerged
and unpushed; the single spec commit exists only in this note's history. There is
nothing to revert and nothing depending on it.
