# Implementation Plan: League Onboarding

**Branch**: `001-league-onboarding` | **Date**: 2026-08-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-league-onboarding/spec.md`

## Summary

Build the account + league-setup foundation of Draft Genie: passwordless
email sign-in, encrypted storage of the user's ESPN cookie pair, connection
and validation of multiple ESPN leagues per account, full league-settings
sync (scoring rules, roster composition, draft details), a dashboard, and
automatic repeated re-sync in the ~75-minute pre-draft window to capture the
late-published draft order.

Technical approach (ratified platform: **Cloudflare**): a single Cloudflare
Worker serving both a JSON API (Hono) and a static React SPA, with D1 as the
relational store, WebCrypto AES-GCM encryption for ESPN cookies, a
provider-agnostic email adapter for magic-link/code delivery, and a Cron
Trigger every 5 minutes driving the pre-draft sync window. WebSockets (also
ratified) are not needed by this feature; they arrive with 004-draft-monitor.

## Technical Context

**Language/Version**: TypeScript 5.x (strict) on Cloudflare Workers runtime

**Primary Dependencies**: Hono (API routing), Zod (input validation), React 18 + Vite (SPA), wrangler (dev/deploy)

**Storage**: Cloudflare D1 (SQLite) — accounts, encrypted credentials, league connections, settings snapshots

**Testing**: Vitest with `@cloudflare/vitest-pool-workers`; ESPN client tested against recorded JSON fixtures (no live ESPN in CI)

**Target Platform**: Cloudflare Workers (API + static assets); browsers: iPad Safari and desktop Chrome/Safari/Firefox

**Project Type**: Web application — SPA + API in one Worker

**Performance Goals**: Dashboard render < 1 s on broadband; single-league ESPN sync < 10 s; pre-draft sync granularity ≤ 5 min (satisfies SC-004's 5-minute bound)

**Constraints**: ESPN cookies never leave the server after entry (masked display only); GET-only ESPN client (constitution VI); polite ESPN polling; stateless signed-cookie sessions (no server session store)

**Scale/Scope**: Personal-scale SaaS — tens of accounts, ≤ 5 leagues each, ~6 SPA screens; one league sync touches ~2 ESPN endpoints

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Spec-first | PASS | Approved spec + clarifications precede this plan |
| II. Any-league by design | PASS | League IDs/credentials entered via setup UI; nothing hardcoded; behavior derived from synced ESPN settings |
| III. League's currency | PASS | Sync stores the raw stat-category → point-value map per league so downstream features re-score exactly |
| IV. Rules are code | N/A (guarded) | No recommendation rules in this feature; no rule knobs introduced |
| V. Draft day unforgiving | PASS | Pre-draft window auto-sync every ≤ 5 min; failed syncs serve last-good data labeled with age |
| VI. Recommend, never act | PASS | ESPN client exposes read (GET) operations only — no write methods exist |
| VII. Explainable recommendations | N/A | No recommendations in this feature |
| VIII. Simplicity first | PASS | One Worker, one D1 database, no external auth provider; the email adapter is the sole third-party service |
| Security & privacy constraints | PASS | AES-GCM encryption at rest, masked-only display, log redaction, secrets never in URLs (see research.md §5) |

**Post-Phase-1 re-check**: PASS — design artifacts introduce no new projects,
services, or config surfaces beyond the above.

## Project Structure

### Documentation (this feature)

```text
specs/001-league-onboarding/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── api.md           # Phase 1 output — HTTP API contract
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
wrangler.jsonc            # Worker config: D1 binding, cron trigger, assets, secrets
package.json
migrations/               # D1 SQL migrations (0001_init.sql, ...)
src/
├── index.ts              # Worker entry: fetch (Hono app) + scheduled (cron) handlers
├── api/                  # Route modules: auth.ts, credentials.ts, leagues.ts, account.ts
├── auth/                 # OTP/magic-link issuance & verification, session cookie signing
├── crypto/               # AES-GCM encrypt/decrypt for the ESPN cookie pair
├── email/                # EmailSender interface; adapters: resend.ts, console.ts (dev)
├── espn/                 # Read-only ESPN client, response parsers, TS types for views
├── sync/                 # League sync orchestration; pre-draft window scan (cron)
└── db/                   # D1 query helpers per entity (accounts, credentials, leagues)
web/                      # React SPA (Vite project)
├── index.html
└── src/
    ├── pages/            # SignIn, Dashboard, CredentialSetup, ConnectLeague, LeagueDetail
    ├── components/
    └── api.ts            # Typed fetch client for /api
tests/
├── contract/             # API contract tests (vitest-pool-workers)
├── integration/          # Connect/sync flows against ESPN fixtures
├── unit/                 # crypto round-trip, parsers, team matching, URL extraction
└── fixtures/espn/        # Recorded ESPN JSON responses (sanitized)
```

**Structure Decision**: Single-project layout — one Worker owns the API, the
scheduled sync, and serves the built SPA from `web/dist` via Workers static
assets. A separate backend/frontend split (two deployables) was rejected as
unnecessary at this scale (constitution VIII); the SPA is a subdirectory with
its own Vite build, not its own service.

## Complexity Tracking

No constitution violations to justify — table intentionally empty.
