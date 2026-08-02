# Draft Genie Constitution

Draft Genie is a live-draft assistant for ESPN fantasy football. It listens to a
league's live online draft in real time and, when the user is on the clock,
recommends the right player to pick based on a proprietary rule set.

## Core Principles

### I. Spec-First Development (NON-NEGOTIABLE)
Every feature follows the Spec Kit cycle: `/speckit-specify` → (`/speckit-clarify`
if ambiguous) → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`. No
implementation code is written for a feature without an approved spec and plan.
Features are deliberately small (see ROADMAP.md) so each cycle fits in one
working session.

### II. Any-League by Design
The app MUST work for anyone with an ESPN fantasy football team, not just the
maintainer's leagues. No league IDs, team IDs, or credentials are hardcoded.
League connection happens through a setup page. All league-specific behavior
(scoring, roster slots, team count, draft type) is derived from the league's own
ESPN settings at sync time.

### III. Score in the League's Currency
Every projection, value calculation, and recommendation MUST be computed using
the connected league's actual scoring settings pulled from ESPN — never a
generic PPR/standard assumption. If two leagues score the same stat line
differently, Draft Genie's numbers differ accordingly.

### IV. The Rules Are Code, Not Config
The recommendation rule set (value-based drafting, team offensive potential,
strength of schedule, bye weeks, offensive line ranking, and future signals) is
the product's secret sauce. Rules live in versioned code with tests — they are
NOT user-configurable settings. The only user-supplied inputs to the engine are
the league context and the user's preferred-player list. Rule changes go through
their own spec sessions.

### V. Draft Day Is Unforgiving
A live draft cannot be paused or replayed. The draft monitor and recommendation
path MUST tolerate disconnects, ESPN API hiccups, and page reloads: reconnect
automatically, recover full draft state from ESPN on demand, and have a
recommendation ready before the user is on the clock — not computed after the
clock starts. Pre-computation ahead of the user's turn is the default design.

### VI. Recommend, Never Act
Draft Genie is read-only against ESPN. It observes the draft and recommends;
it NEVER submits a pick, changes a roster, or writes anything to ESPN on the
user's behalf. The human makes every pick in ESPN's own interface.

### VII. Explainable Recommendations
Every recommendation shows its "why": the value score, the rule signals that
moved the player up or down (e.g. "top-5 offense, bye week clash with your QB,
preferred-list boost"), and the next-best alternatives. A bare name with no
reasoning is a spec violation.

### VIII. Simplicity First
Prefer the simplest data source and design that satisfies the spec: ESPN
projections by default (other sources only if a spec justifies the added
complexity), one hosting platform, no speculative configurability (YAGNI).

## Security & Privacy Constraints

- ESPN credentials (`espn_s2` cookie, `SWID`) are secrets: stored encrypted,
  never logged, never exposed to the client after entry, never placed in URLs.
- The app never asks for the user's ESPN username/password — only the two
  cookies (with clear in-app instructions for retrieving them).
- Per-user data isolation: one user can never see another user's leagues,
  credentials, or preferred lists.

## Technical Constraints

- Delivery target: responsive web app usable on iPad and desktop browsers. No
  native app.
- Hosting: Cloudflare (Workers platform) or Fly.io — a single platform, chosen
  and ratified in the first feature's `/speckit-plan` and recorded in ROADMAP.md.
- ESPN has no public push API for drafts; assume the monitor polls ESPN's
  fantasy API and fans out updates to clients (WebSocket/SSE). Poll intervals
  must be respectful of ESPN's servers.

## Development Workflow

- One feature per spec-kit cycle, on its own git branch, merged when its tasks
  are complete and tested.
- The recommendation engine MUST be testable offline via recorded/replayed
  drafts (see ROADMAP.md feature 008) — rule changes are validated against
  replays before draft day.
- Cross-feature contracts (data models, API shapes) are written down in the
  owning feature's spec and referenced, not duplicated.

## Governance

This constitution supersedes ad-hoc practices. Amendments are made by editing
this file in its own commit with a version bump and rationale. All
`/speckit-plan` outputs must include a Constitution Check against these
principles; violations require an explicit, documented justification or a
constitution amendment.

**Version**: 1.0.1 | **Ratified**: 2026-08-02 | **Last Amended**: 2026-08-02

<!-- 1.0.1: cross-reference fix — replay lab renumbered 007→008 in the
     2026-08-02 roadmap renumbering. No principle changes. -->
