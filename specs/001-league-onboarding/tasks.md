# Tasks: League Onboarding

**Input**: Design documents from `/specs/001-league-onboarding/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Included — the plan's testing strategy (research.md §9) and success
criteria (SC-005, SC-006) explicitly require contract/unit/integration
coverage. Write each story's tests first and watch them fail.

**Organization**: Grouped by user story from spec.md so each story is an
independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 (connect league), US2 (multi-league), US3 (freshness), US4 (any device)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Runnable empty app: Worker + SPA + D1 + tests all wired.

- [ ] T001 Initialize npm project at repo root: `package.json` (scripts: dev, build, test, deploy), `tsconfig.json` strict, deps per plan.md (hono, zod; dev: wrangler, vitest, @cloudflare/vitest-pool-workers, typescript)
- [ ] T002 Create `wrangler.jsonc`: D1 binding `DB`, cron trigger `*/5 * * * *`, assets directory `web/dist` with SPA fallback, secret names documented (`SESSION_SECRET`, `CREDENTIAL_KEY`, `RESEND_API_KEY`), `.dev.vars.example`
- [ ] T003 [P] Scaffold Vite + React SPA in `web/` (`web/index.html`, `web/src/main.tsx`, `web/src/App.tsx` with router shell, `web/vite.config.ts` proxying `/api` to wrangler dev)
- [ ] T004 [P] Configure ESLint + Prettier at repo root (`eslint.config.js`, `.prettierrc`) covering `src/`, `web/src/`, `tests/`
- [ ] T005 [P] Configure Vitest workers pool in `vitest.config.ts` (miniflare D1 binding, `.dev.vars` test secrets) with a smoke test `tests/unit/smoke.test.ts`
- [ ] T006 Write D1 migration `migrations/0001_init.sql`: tables `accounts`, `login_tokens`, `espn_credentials`, `league_connections`, `league_snapshots` + indexed `draft_at` column + unique constraints per data-model.md; verify `wrangler d1 migrations apply --local` succeeds

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Auth, crypto, ESPN client, and app skeleton every story needs.

**⚠️ CRITICAL**: No user story work until this phase completes.

- [ ] T007 [P] Implement AES-256-GCM credential encryption in `src/crypto/credentials.ts` (encrypt/decrypt with `CREDENTIAL_KEY`, IV-prepended ciphertext) with round-trip + tamper-detection tests in `tests/unit/crypto.test.ts`
- [ ] T008 [P] Implement stateless session cookie in `src/auth/session.ts` (HMAC-SHA256 sign/verify `{account_id, exp}`, 30-day expiry, cookie attrs HttpOnly/Secure/SameSite=Lax) with tests in `tests/unit/session.test.ts`
- [ ] T009 [P] Implement `EmailSender` interface + adapters in `src/email/index.ts`, `src/email/console.ts` (dev: log code/link), `src/email/resend.ts` (POST api.resend.com, key from env)
- [ ] T010 Create Hono app skeleton in `src/index.ts` + `src/api/app.ts`: JSON error envelope `{error, message}` per contracts/api.md, auth middleware reading `dg_session`, secret-redacting log wrapper in `src/api/logging.ts` (strips `espn_s2`/SWID patterns), static-assets fallback, empty `scheduled` export
- [ ] T011 Implement D1 access helpers `src/db/client.ts` (typed query helpers) and `src/db/accounts.ts` (create/find by email, delete cascade)
- [ ] T012 Implement passwordless auth in `src/auth/tokens.ts` (issue 6-digit code + link token, SHA-256 at rest, 10-min expiry, single-use, ≤3 outstanding, ≤5 attempts; storage via `src/db/loginTokens.ts`) and routes in `src/api/auth.ts` (`POST /api/auth/request`, `POST /api/auth/verify`, `GET /api/auth/magic`, `POST /api/auth/signout`) per contracts/api.md
- [ ] T013 Contract tests for auth flow in `tests/contract/auth.test.ts`: request→verify sets cookie, invalid/expired/consumed codes 422, rate limit 429, no account enumeration (always 204), magic-link redirect behavior
- [ ] T014 [P] Implement read-only ESPN client in `src/espn/client.ts` + `src/espn/types.ts`: GET-only methods `fetchLeague(view…)`, Cookie-header auth, configurable base URL, per-league minimum interval of 30 s between full syncs (bypassed inside the pre-draft window, where the 5-min cron is the pace), error mapping (401/403→`espn_rejected`, 404→`league_not_found`, network→`espn_unreachable`)
- [ ] T015 [P] Record sanitized ESPN fixtures in `tests/fixtures/espn/`: `settings-team.json` (mSettings+mTeam) for ≥2 scoring shapes, one odd-shape league (`settings-odd.json` — tiny team count and/or no bench slots, per spec edge case), `draftdetail-unpublished.json`, `draftdetail-published.json`, `error-401.json`; document recording steps in `tests/fixtures/espn/README.md`

**Checkpoint**: Sign-in works end-to-end in dev (code via console adapter); ESPN client tested against fixtures.

---

## Phase 3: User Story 1 - Connect an ESPN league (Priority: P1) 🎯 MVP

**Goal**: From fresh sign-in to a connected league showing true ESPN settings and the user's own team.

**Independent Test**: Quickstart scenarios 1–3 — real ESPN league connects via pasted cookies + league URL; settings match ESPN category-for-category (SC-001/002).

### Tests for User Story 1

- [ ] T016 [P] [US1] Contract tests for credentials endpoints in `tests/contract/credentials.test.ts`: PUT normalizes then validates against stubbed ESPN, 422 `espn_rejected` stores nothing, GET returns masked SWID only, 502 pass-through; on replace with existing connections, response `leagues_revalidated` equals connection count and league/credential statuses update (FR-007)
- [ ] T017 [P] [US1] Contract tests for league connect in `tests/contract/leagues-connect.test.ts`: POST by id and by URL → 201 shape, 409 `team_choice_required` + `connect_token` flow, each 422 code (`no_credentials`, `league_not_found`, `not_football`, `wrong_season`, `already_connected`, `unparseable_ref`)
- [ ] T018 [P] [US1] Integration test full connect journey in `tests/integration/connect-flow.test.ts`: sign in → store credentials → connect fixture league → GET detail matches fixture scoring exactly (SC-002)

### Implementation for User Story 1

- [ ] T019 [P] [US1] Implement credential storage in `src/db/credentials.ts` (upsert ciphertexts + masked SWID, status transitions per data-model.md state machine)
- [ ] T020 [P] [US1] Implement cookie normalization in `src/auth/normalizeCookies.ts` (trim quotes/whitespace, SWID brace/case fixup) with unit tests in `tests/unit/normalize.test.ts` (FR-004)
- [ ] T021 [P] [US1] Implement league-ref parsing in `src/espn/leagueRef.ts` (ID or ESPN URL → leagueId/season) with unit tests in `tests/unit/leagueRef.test.ts` (FR-010)
- [ ] T022 [P] [US1] Implement ESPN response parsers in `src/espn/parsers.ts` (mSettings→scoring map + roster slots, mTeam→teams/managers, draft settings→draft_json) with fixture-driven unit tests in `tests/unit/parsers.test.ts`, including the odd-shape fixture (tiny/no-bench league must parse without error) (constitution III: lossless scoring map)
- [ ] T023 [P] [US1] Implement team auto-match in `src/espn/identifyTeam.ts` (SWID ↔ members[].id ↔ team owners) with unit tests in `tests/unit/identifyTeam.test.ts` (FR-014)
- [ ] T024 [US1] Implement credentials routes in `src/api/credentials.ts` (PUT validate-then-store via ESPN probe — and on replacement, re-validate every connected league, update credential + per-league statuses, return `leagues_revalidated` per FR-007; GET masked status) (depends on T019/T020)
- [ ] T025 [US1] Implement connect service in `src/sync/connect.ts`: validate league → sync snapshot → auto-match team → create connection atomically; 409 `connect_token` (10-min signed token) manual-pick path; no partial rows on failure (depends on T021–T023)
- [ ] T026 [US1] Implement league connect routes in `src/api/leagues.ts` (`POST /api/leagues`, `POST /api/leagues/connect/complete` taking `{connect_token, espn_team_id}`, `GET /api/leagues/:id` detail incl. `snapshot_age_seconds`) + `src/db/leagues.ts` (connections + snapshots CRUD, account-scoped) (depends on T025)
- [ ] T027 [P] [US1] Build SPA sign-in page in `web/src/pages/SignIn.tsx` (email → code entry) + typed API client `web/src/api.ts`
- [ ] T028 [P] [US1] Build credential setup page in `web/src/pages/CredentialSetup.tsx` with step-by-step cookie retrieval instructions, normalization-tolerant inputs, masked confirmation state
- [ ] T029 [US1] Build connect + detail pages in `web/src/pages/ConnectLeague.tsx` (ref input, team-pick dialog on 409, per-code error text) and `web/src/pages/LeagueDetail.tsx` (full scoring table, roster slots, teams, draft info; times in local tz) (depends on T027/T028)

**Checkpoint**: MVP — a real user can sign in, store cookies, connect a league, and read its true settings.

---

## Phase 4: User Story 2 - Manage multiple leagues (Priority: P2)

**Goal**: All leagues under one account on a dashboard, isolated, removable.

**Independent Test**: Quickstart scenario 4 — two+ leagues with different scoring show distinct settings; removing one leaves the rest.

### Tests for User Story 2

- [ ] T030 [P] [US2] Contract tests in `tests/contract/leagues-list.test.ts`: GET /api/leagues ordering (soonest draft first, nulls last), DELETE removes connection+snapshot only, cross-account access is 404 (FR-003)
- [ ] T031 [P] [US2] Integration test in `tests/integration/multi-league.test.ts`: connect five fixture leagues (distinct ids, ≥2 scoring shapes — proves the FR-011 "at least 5" bound), verify no settings bleed-through, delete one, others intact

### Implementation for User Story 2

- [ ] T032 [US2] Implement dashboard list + delete in `src/api/leagues.ts` (`GET /api/leagues` LeagueSummary array with derived `scoring_summary` label, `DELETE /api/leagues/:id`) extending `src/db/leagues.ts` with ordered list query
- [ ] T033 [US2] Build dashboard page in `web/src/pages/Dashboard.tsx`: league cards (name, my team, scoring summary, draft countdown in local tz, sync + credential status badges), unsupported-draft-type notice when `draft.supported` is false ("live-draft assistance covers online snake drafts initially" — spec edge case), remove with confirm, empty state pointing to setup

**Checkpoint**: US1 + US2 — the three-league household works end-to-end.

---

## Phase 5: User Story 3 - Keep league settings fresh (Priority: P3)

**Goal**: Manual re-sync anytime; automatic repeated re-sync in the pre-draft window; stale data never disappears.

**Independent Test**: Quickstart scenarios 6–7 — settings change appears after "sync now"; `__scheduled` curl within the T-75 window picks up the published draft order (SC-004); failed sync keeps labeled stale data (FR-020).

### Tests for User Story 3

- [ ] T034 [P] [US3] Contract tests in `tests/contract/leagues-sync.test.ts`: POST /:id/sync refreshes snapshot; ESPN-unreachable sync → 200 with `sync_status: "failed"` + warning + stale snapshot retained; ESPN 401 flips credential status to `failing` (FR-008)
- [ ] T035 [P] [US3] Integration test cron scan in `tests/integration/predraft-cron.test.ts` (fake clock): league with draft in 70 min gets synced by scheduled handler; league 3 h out untouched; draft order transitions unpublished→published within one tick

### Implementation for User Story 3

- [ ] T036 [US3] Implement refresh service in `src/sync/refresh.ts`: re-pull settings+mDraftDetail, overwrite snapshot, update `last_sync_at`/`last_sync_status`, propagate credential failure state without data loss (FR-018/020, FR-008)
- [ ] T037 [US3] Implement `POST /api/leagues/:id/sync` route in `src/api/leagues.ts` returning refreshed detail (depends on T036)
- [ ] T038 [US3] Implement pre-draft window scan in `src/sync/predraft.ts` + wire `scheduled` handler in `src/index.ts`: query `draft_at ∈ [now−15m, now+75m]` and not completed → refresh each (FR-019, research.md §8)
- [ ] T039 [US3] Surface freshness in SPA: "sync now" button + last-synced age + stale-warning banner + "credentials need refresh" call-to-action in `web/src/pages/Dashboard.tsx` and `web/src/pages/LeagueDetail.tsx`

**Checkpoint**: Draft order lands automatically within 5 minutes of ESPN publishing it.

---

## Phase 6: User Story 4 - Return on any device (Priority: P4)

**Goal**: Same account and leagues from any browser; clean sign-out.

**Independent Test**: Quickstart scenario 1 second half — set up in browser A, sign in from browser B, dashboard identical with zero ESPN re-entry (SC-007).

### Tests for User Story 4

- [ ] T040 [P] [US4] Integration test in `tests/integration/multi-device.test.ts`: two independent cookie jars against one account — second sign-in sees all leagues; signed-out jar gets 401 on every protected endpoint

### Implementation for User Story 4

- [ ] T041 [US4] Add account/session UI in `web/src/components/AccountMenu.tsx`: signed-in email display, sign-out (clears cookie, returns to SignIn), wire into `web/src/App.tsx` layout with route guard redirecting unauthenticated users

**Checkpoint**: All four stories independently green.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T042 [P] Secret-hygiene sweep test in `tests/contract/no-secrets.test.ts`: exercise every endpoint and captured log line, assert zero occurrences of fixture `espn_s2`/unmasked SWID values (SC-005)
- [ ] T043 [P] Implement account deletion `DELETE /api/account` in `src/api/account.ts` (cascade per data-model.md, clears cookie) + danger-zone UI in `web/src/pages/Account.tsx` with typed-confirmation (FR-009)
- [ ] T044 [P] Time-zone rendering audit across SPA pages (all timestamps via one `web/src/lib/time.ts` helper, local tz + relative ages) (FR-023)
- [ ] T045 Run full quickstart.md validation against a real ESPN account (3 real leagues for SC-002/SC-003), record results in `specs/001-league-onboarding/quickstart-results.md`
- [ ] T046 First production deploy: `wrangler d1 migrations apply` remote, `wrangler secret put` × 3, `npm run deploy`, smoke-test sign-in + league connect on the deployed URL; update `README.md` status section

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: none
- **Foundational (P2)**: after Setup — BLOCKS all stories
- **US1 (P3)**: after Foundational
- **US2 (P4)**: after US1 (dashboard lists what connect creates; shares `src/api/leagues.ts`)
- **US3 (P5)**: after US1 (refresh reuses connect's sync path); independent of US2
- **US4 (P6)**: after Foundational only (sessions already stateless); UI task after any story exists to look at
- **Polish (P7)**: after all stories

### Within Each User Story

- Tests first (watch them fail) → db/models → services → routes → SPA pages
- Same-file tasks are sequential (e.g. T026 → T032 → T037 all touch `src/api/leagues.ts`)

### Parallel Opportunities

- Setup: T003, T004, T005 together after T001/T002
- Foundational: T007, T008, T009 together; T014, T015 together after T010
- US1: T016–T018 (tests) together; then T019–T023 together; SPA T027/T028 parallel to API T024–T026
- US3 can run in parallel with US2 (different files except the shared `src/api/leagues.ts` route additions — coordinate T032/T037)

## Parallel Example: User Story 1

```bash
# Tests first, in parallel:
Task: "Contract tests for credentials endpoints in tests/contract/credentials.test.ts"
Task: "Contract tests for league connect in tests/contract/leagues-connect.test.ts"
Task: "Integration test full connect journey in tests/integration/connect-flow.test.ts"

# Then the independent building blocks:
Task: "Credential storage in src/db/credentials.ts"
Task: "Cookie normalization in src/auth/normalizeCookies.ts"
Task: "League-ref parsing in src/espn/leagueRef.ts"
Task: "ESPN response parsers in src/espn/parsers.ts"
Task: "Team auto-match in src/espn/identifyTeam.ts"
```

## Implementation Strategy

**MVP first**: Phases 1–3 only, then STOP and validate US1 against a real
league (quickstart scenarios 1–3). That alone is demo-able: "my league's
true settings, synced."

**Incremental delivery**: add US2 (the three-league dashboard), then US3
(freshness + the draft-order cron — the draft-day-critical piece), then US4
polish, then the cross-cutting phase ending in the first production deploy
(T046). Each checkpoint leaves a deployable app; commit lands automatically
per step via the git extension.
