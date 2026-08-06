<!--
Sync Impact Report — 2026-08-03
Version: 1.0.1 → 1.1.0 (MINOR: materially expanded an existing principle and
widened a technical constraint; no principle removed or redefined)

Modified principles:
  - VI. Recommend, Never Act — expanded with an explicit observation boundary.
    Motivated by 005 Gate 0: ESPN's draft-room protocol admits a client only by
    JOINing, which registers a participant, announces it to the room, and
    requires periodic writes. "Read-only" needed to say that observing must
    never require speaking.

Modified sections:
  - Technical Constraints — delivery target now permits ONE optional, strictly
    passive browser companion; corrected the factual claim about ESPN draft
    polling, which 005 Gate 0 disproved empirically.

Added sections: none. Removed sections: none. Deferred TODOs: none.
-->

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
automatically, recover full draft state on demand, and have a recommendation
ready before the user is on the clock — not computed after the clock starts.
Pre-computation ahead of the user's turn is the default design.

### VI. Recommend, Never Act
Draft Genie is read-only against ESPN. It observes the draft and recommends;
it NEVER submits a pick, changes a roster, or writes anything to ESPN on the
user's behalf. The human makes every pick in ESPN's own interface.

**Observation is not participation.** Draft Genie MUST NOT open a connection to
ESPN's draft room, transmit any message on that channel, or take any action that
registers it as a participant in a draft. ESPN's draft-room protocol admits a
client only by joining — which marks the account online, announces it to the
room, and requires periodic writes to stay connected — so joining as an observer
is not available to us, and a second session risks displacing the user from
their own draft. Observing a live draft is permitted ONLY by passively reading
data the user's own browser session is already receiving. **If observing would
require us to speak, we do not observe.**

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
  never logged, never committed, never exposed to the client after entry, never
  placed in URLs. This includes test fixtures — captured ESPN responses carry
  member GUIDs (which are SWIDs) and real names, and MUST be sanitized before
  they reach the repository.
- The app never asks for the user's ESPN username/password — only the two
  cookies (with clear in-app instructions for retrieving them).
- Per-user data isolation: one user can never see another user's leagues,
  credentials, or preferred lists.
- **A league's draft picks are shared among that league's managers** (ratified
  2026-08-06, during 011). Every manager in a draft is already watching the same
  ESPN room; the picks are the shared event, not one manager's private data. So
  relayed draft frames may be read across accounts within one league and season,
  while **perspective stays per-account** — a manager's own team, settings and
  preferred list are never taken from anyone else.
  - Entitlement to another manager's frames requires **verified membership**:
    the account's SWID appearing in that team's ESPN owner list
    (`team_match_source = 'auto'`). Merely holding a connection row is not
    enough — a league id is guessable, and connecting does not prove membership.
  - Both halves MUST be enforced **in the query**, not by a comparison a call
    site could forget. Never infer entitlement from row counts or volume.

## Technical Constraints

- Delivery target: responsive web app usable on iPad and desktop browsers. No
  native app.
- **One exception (added 2026-08-03)**: a single OPTIONAL browser companion —
  userscript or extension — is permitted for the sole purpose of passively
  relaying live draft data the user's own browser is already receiving. It MUST
  be strictly passive under Principle VI, it MUST remain the only such artifact,
  and the web app MUST stay fully usable without it. Absent the companion the
  product degrades to "no live draft monitoring", stated plainly to the user —
  never to a broken experience, and never to a silently stale one. Any other
  installed or native artifact remains out of scope.
- Hosting: Cloudflare (Workers platform) or Fly.io — a single platform, chosen
  and ratified in the first feature's `/speckit-plan` and recorded in ROADMAP.md.
- **ESPN's read API cannot observe a draft in progress** (established
  empirically 2026-08-03 — feature 005 Gate 0, 207 samples across ~30 real
  picks): the league database is written once, when the draft completes.
  Polling remains correct for everything else ESPN exposes — league settings,
  rosters, projections, draft order, and the draft start/finish flags — and poll
  intervals MUST be respectful of ESPN's servers. Live picks are available only
  through the browser companion above.

## Development Workflow

- One feature per spec-kit cycle, on its own git branch, merged when its tasks
  are complete and tested.
- A feature whose premise rests on an unverified external behavior MUST verify
  it first, in the cheapest possible experiment, before any dependent code is
  written. 005 Gate 0 established the pattern: one evening's capture disproved a
  data source that eight phases of work assumed.
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

**Version**: 1.1.0 | **Ratified**: 2026-08-02 | **Last Amended**: 2026-08-03

<!-- 1.0.1: cross-reference fix — replay lab renumbered 007→008 in the
     2026-08-02 roadmap renumbering. No principle changes. -->
<!-- 1.1.0: Principle VI gains an explicit observation boundary; Technical
     Constraints permit one optional passive browser companion and record the
     empirical finding that ESPN's read API cannot see a draft in progress.
     Security constraints extend the secrets rule to test fixtures. -->
