# Feature Specification: League Onboarding

**Feature Branch**: `001-league-onboarding`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "001 Let's go with cloudflare and websockets. The app must account for multiple leagues to be setup."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect an ESPN league (Priority: P1)

A fantasy football manager opens Draft Genie for the first time, creates an
account, and connects one of their ESPN leagues. They paste their ESPN access
cookies (`espn_s2` and `SWID`) following step-by-step in-app instructions,
then identify the league (by league ID or by pasting the league's URL). Draft
Genie validates access, pulls the league's configuration from ESPN — league
name, scoring rules, roster composition, number of teams, draft type, and
scheduled draft date/time — determines which team in the league belongs to
them, and shows the league on their dashboard with its settings summarized.

**Why this priority**: Nothing else in the product (projections, draft
monitoring, recommendations) can function without a validated, connected
league and its settings. This is the smallest slice that proves end-to-end
ESPN connectivity and delivers standalone value: "my league's real settings,
readable in one place."

**Independent Test**: With a real ESPN account that belongs to a private
league, a new user can go from first visit to seeing that league's correct
scoring settings and their own team name on the dashboard, using only in-app
instructions.

**Acceptance Scenarios**:

1. **Given** a new user with valid ESPN cookies for a private league,
   **When** they enter credentials and the league identifier, **Then** the
   league appears on their dashboard showing league name, team count, scoring
   type summary, roster composition, their team name, and the scheduled draft
   date/time.
2. **Given** a user entering an invalid or expired cookie value, **When**
   validation runs, **Then** they see a clear error explaining ESPN denied
   access, with guidance to re-copy the cookies — and the failed values are
   not stored.
3. **Given** a user who belongs to a public league, **When** they connect it
   without providing cookies, **Then** the league connects in read-only mode
   if ESPN allows anonymous access to it, and the user is told credentials
   may be needed for private data.
4. **Given** a league identifier for a league the user's ESPN identity has no
   team in, **When** validation runs, **Then** the league can still be
   connected but the user is prompted to confirm they have no team (observer
   mode) or to pick their team manually if automatic matching failed.
5. **Given** a connected league, **When** the user views its settings page,
   **Then** every scoring rule shown matches the values in ESPN's own league
   settings page.

---

### User Story 2 - Manage multiple leagues (Priority: P2)

A manager who plays in several leagues (e.g. three) connects each of them
under one account. The dashboard lists all connected leagues with their draft
dates, and the user can open any league, re-check its settings, or remove a
league they no longer want.

**Why this priority**: The primary user drafts in three leagues; the product
brief requires multi-league support explicitly. It builds directly on User
Story 1 but is separable — one league working end-to-end is still a viable
MVP.

**Independent Test**: Connect two or more distinct leagues under one account;
verify each shows its own (different) scoring settings and draft times, and
that removing one league leaves the others intact.

**Acceptance Scenarios**:

1. **Given** a user with one connected league, **When** they connect a second
   league using the same ESPN credentials, **Then** both leagues appear on
   the dashboard, each with its own settings, without re-entering cookies.
2. **Given** two connected leagues with different scoring rules, **When** the
   user views each league's settings, **Then** the values shown are
   league-specific (no bleed-through between leagues).
3. **Given** a connected league, **When** the user removes it, **Then** it
   disappears from the dashboard and its stored league data is deleted, while
   other leagues are unaffected.
4. **Given** leagues sorted on the dashboard, **When** draft dates are known,
   **Then** leagues are ordered by soonest upcoming draft first.

---

### User Story 3 - Keep league settings fresh (Priority: P3)

League managers tweak settings (scoring, roster slots, draft time) during the
preseason, and ESPN publishes the draft order only about an hour before the
draft. The user can trigger a re-sync at any time from the league page, and
Draft Genie automatically re-syncs each league as its scheduled draft
approaches so that draft time, draft order, and settings are current without
manual action.

**Why this priority**: Stale settings poison every downstream feature, but
manual re-sync is a workaround, so this lands after the core connect flows.

**Independent Test**: Change a scoring value in ESPN, trigger re-sync in
Draft Genie, and confirm the new value appears with a "last synced" timestamp
update; separately verify a league with an imminent draft refreshes on its
own.

**Acceptance Scenarios**:

1. **Given** a connected league whose settings changed in ESPN, **When** the
   user triggers "sync now", **Then** the updated settings are shown along
   with a new last-synced timestamp.
2. **Given** a league whose scheduled draft is approaching, **When** the
   pre-draft window begins (about an hour before draft time), **Then** the
   league's settings and draft details are refreshed automatically, capturing
   the just-published draft order and any draft-time change.
3. **Given** a re-sync attempt while ESPN is unreachable, **When** the sync
   fails, **Then** the previously synced data remains available, marked with
   its age, and the user sees a non-blocking warning.

---

### User Story 4 - Return on any device (Priority: P4)

A user who set up their leagues on a computer signs in on their iPad (or vice
versa) and finds the same account, leagues, and settings — without
re-entering ESPN cookies.

**Why this priority**: Draft-day usage spans devices (setup at a desk, draft
on an iPad), but single-device usage is workable until then.

**Independent Test**: Complete setup in one browser, sign in from a second
device/browser, and verify all leagues appear without re-entering ESPN
credentials.

**Acceptance Scenarios**:

1. **Given** an account with connected leagues, **When** the user signs in on
   a different device, **Then** the same dashboard appears and no ESPN cookie
   re-entry is required.
2. **Given** a signed-in session, **When** the user signs out, **Then**
   account data is no longer accessible from that device until they sign in
   again.

---

### Edge Cases

- ESPN cookies expire or are revoked mid-season: the app must detect failing
  credentials during any sync, mark all leagues using them as
  "credentials need refresh", and let the user re-enter cookies once for all
  their leagues.
- The same ESPN league is connected by two different Draft Genie accounts
  (e.g. two managers in one league both use the app): each account's data,
  credentials, and view are fully isolated; neither can see the other.
- The league identifier points to a non-football or archived/previous-season
  league: validation rejects it with a specific reason rather than a generic
  failure.
- The league uses a draft type the product doesn't yet support for
  recommendations (e.g. auction, offline draft): the league may still be
  connected and viewed, with a notice that live-draft assistance covers
  online snake drafts initially.
- The user pastes cookies with surrounding whitespace, quotes, or the SWID
  braces missing: input is normalized before validation rather than failing.
- The league has an unusual size or configuration (e.g. 2-team test league,
  20-team league, no bench slots): settings sync and display must not break.
- ESPN is temporarily unreachable during first connect: the user gets a
  retryable error; no partial league appears on the dashboard.

## Requirements *(mandatory)*

### Functional Requirements

**Identity & access**

- **FR-001**: The system MUST let a person create an individual account and
  sign back into it later; all connected leagues, credentials, and
  preferences belong to exactly one account.
- **FR-002**: The system MUST support sign-in from multiple devices to the
  same account, and MUST NOT require re-entry of ESPN credentials per device.
- **FR-003**: The system MUST isolate all data per account: no account can
  read or infer another account's leagues, credentials, teams, or settings.

**ESPN credentials**

- **FR-004**: The system MUST let a user store their ESPN access cookies
  (`espn_s2` and `SWID`) with clear in-app, step-by-step retrieval
  instructions, and MUST normalize common paste mistakes (whitespace,
  quotes, missing SWID braces) before validation.
- **FR-005**: The system MUST validate credentials against ESPN at entry
  time and reject invalid ones with an actionable error; rejected values
  MUST NOT be persisted.
- **FR-006**: The system MUST treat ESPN cookies as secrets: stored
  encrypted, never displayed back after entry (beyond a masked
  confirmation), never written to logs, never included in URLs, and never
  sent to the user's browser after initial submission.
- **FR-007**: The system MUST allow a user to replace their stored ESPN
  credentials at any time, and replacing them MUST re-validate all connected
  leagues using them.
- **FR-008**: The system MUST detect during any ESPN interaction that stored
  credentials have stopped working, and MUST surface a "credentials need
  refresh" state on the affected leagues without deleting any synced data.
- **FR-009**: The system MUST allow a user to delete their account, which
  MUST remove their stored credentials and league data.

**League connection**

- **FR-010**: The system MUST let a user connect a league by ESPN league ID
  or by pasting an ESPN league URL from which the ID can be extracted.
- **FR-011**: The system MUST support connecting multiple leagues per
  account (at least 5), reusing the account's stored ESPN credentials.
- **FR-012**: The system MUST validate on connect that the league exists, is
  a fantasy football league for the current season, and is accessible with
  the user's credentials (or anonymously for public leagues), giving a
  distinct error message for each failure mode.
- **FR-013**: The system MUST support connecting public leagues without ESPN
  credentials in read-only mode.
- **FR-014**: The system MUST automatically identify which team in the
  league belongs to the user's ESPN identity; if no team matches, it MUST
  let the user pick their team manually or continue as an observer.
- **FR-015**: The system MUST let a user disconnect a league, removing its
  synced data without affecting other leagues or the stored credentials.

**League settings sync**

- **FR-016**: On connect, the system MUST pull and persist the league's
  configuration from ESPN: league name, season, number of teams, full
  scoring rules (every scored stat category and its point value), roster
  composition (starting slots by position, bench and reserve counts), draft
  type, scheduled draft date/time, and the list of teams and their managers.
- **FR-017**: The system MUST record and display when each league was last
  synced.
- **FR-018**: The system MUST provide an on-demand re-sync per league that
  refreshes all synced configuration.
- **FR-019**: The system MUST automatically re-sync each league when its
  scheduled draft is imminent (within roughly one hour), capturing the
  published draft order and any late changes to draft time or settings.
- **FR-020**: If a sync fails, the system MUST keep serving the most recent
  successful sync's data, labeled with its age, and MUST show a non-blocking
  warning.

**Dashboard**

- **FR-021**: The system MUST show all connected leagues on a dashboard with
  league name, team count, the user's team, scoring summary, and scheduled
  draft date/time, ordered by soonest upcoming draft.
- **FR-022**: The system MUST provide a per-league detail view showing the
  full synced scoring rules and roster composition in a human-readable form.
- **FR-023**: The system MUST display all dates and times in the user's
  local time zone, including the draft countdown.

### Key Entities

- **Account**: A Draft Genie user; owns everything else. Attributes:
  identifier, sign-in identity (email), creation date.
- **ESPN Credential**: The `espn_s2`/`SWID` cookie pair for an account's
  ESPN identity. One active pair per account; referenced by all that
  account's private-league connections; stored encrypted; carries a
  last-validated timestamp and a working/failing status.
- **League Connection**: An account's link to one ESPN league. Attributes:
  ESPN league ID, season, access mode (credentialed / public read-only),
  the user's team reference (or observer), connection date, last-sync
  status.
- **League Settings Snapshot**: The synced configuration of a league —
  name, team count, scoring rule set (stat category → point value), roster
  composition, draft type, draft date/time, draft order (once published) —
  with the sync timestamp it was captured at.
- **League Team**: A team inside a connected league: team name, manager
  name(s), ESPN team ID; one may be flagged as "mine" for the account.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user with an ESPN account can go from landing
  page to seeing a connected league's settings in under 5 minutes, including
  cookie retrieval, using only in-app instructions (no external help).
- **SC-002**: 100% of scored stat categories and roster slots shown for a
  connected league match the values in ESPN's own league settings page,
  verified across at least 3 real leagues with different scoring rules.
- **SC-003**: A user can maintain at least 3 concurrently connected leagues
  under one account, each showing distinct, correct settings.
- **SC-004**: For a league whose draft order was published inside ESPN's
  ~1-hour pre-draft window, Draft Genie reflects that draft order before the
  draft starts, without any manual user action.
- **SC-005**: ESPN cookie values never appear in any log, URL, page source,
  or client-visible payload after initial entry — verified by inspection in
  testing (zero occurrences).
- **SC-006**: Credential entry errors (expired/invalid cookies) are
  identified as such — not shown as generic failures — in 100% of tested
  failure cases, and each error message tells the user what to do next.
- **SC-007**: After initial setup, signing in on a second device shows the
  full dashboard with zero re-entry of ESPN credentials.

## Assumptions

- **Multi-user service**: Draft Genie runs as one shared service where each
  person creates their own account (rather than each person hosting a
  private copy). The constitution's any-league principle plus the brief's
  "usable by anyone with an ESPN team" implies self-serve accounts.
- **Sign-in method**: Accounts are identified by email address with a
  passwordless sign-in flow (e.g. emailed magic link or code); no ESPN
  username/password is ever requested. Exact mechanism is a planning
  decision.
- **One ESPN identity per account**: An account stores one ESPN cookie pair;
  all its private leagues must be visible to that ESPN identity. Supporting
  multiple ESPN identities under one account is out of scope for this
  feature.
- **Current season only**: Onboarding targets the current/upcoming fantasy
  football season; historical seasons are out of scope.
- **Football, ESPN only**: Only ESPN fantasy football leagues are supported;
  other sports and platforms are out of scope.
- **Cookie lifetime**: ESPN cookies are long-lived (typically months);
  mid-season expiry is handled via the "credentials need refresh" flow, not
  automatic renewal.
- **Draft-type breadth**: Any league can be connected and viewed; live-draft
  assistance in later features initially targets online snake drafts.
- **Downstream features out of scope**: Projections, draft monitoring,
  recommendations, and preferred lists are later features (ROADMAP 002+);
  this feature ends at "leagues connected, settings synced and visible".
- **Ratified platform decisions** (recorded in ROADMAP.md, applied in
  `/speckit-plan`, intentionally absent from the requirements above):
  hosting on Cloudflare; real-time delivery via WebSockets.
