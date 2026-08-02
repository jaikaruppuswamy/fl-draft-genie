# Research: League Onboarding (001)

All Technical Context unknowns resolved below. Format per decision:
**Decision / Rationale / Alternatives considered**.

## 1. Worker shape & API framework

**Decision**: One Cloudflare Worker exporting `fetch` (Hono app: `/api/*`
JSON routes + static-asset fallback for the SPA) and `scheduled` (cron).

**Rationale**: Hono is the de-facto standard router on Workers — tiny,
typed, middleware for cookies/CORS built in. One Worker keeps deploys,
secrets, and local dev trivial (constitution VIII) and gives later features
(004 draft monitor) a home in the same deployable where Durable Objects can
be added.

**Alternatives considered**: itty-router (fewer batteries); separate API +
Pages projects (two deployables, more config, no benefit at this scale);
Next.js on Workers (heavyweight, SSR unneeded).

## 2. Frontend

**Decision**: React 18 + Vite SPA in `web/`, built to `web/dist`, served by
the Worker as static assets. Client-side routing; all data via `/api`.

**Rationale**: The later draft-room UI (006) is highly interactive and
real-time; starting with React now avoids a rewrite. Vite gives fast local
dev against `wrangler dev`.

**Alternatives considered**: Hono JSX/htmx server-rendered pages (simpler
today, poor fit for the 006 live draft room); SvelteKit (fine, but React has
the larger ecosystem for later needs — no strong differentiator).

## 3. Storage

**Decision**: Cloudflare D1 (SQLite). Relational tables for accounts,
credentials, league connections; league settings stored as JSON columns in a
latest-snapshot row per connection (see data-model.md).

**Rationale**: The data is relational (account → credential → N leagues) and
queried by shape (leagues whose draft is within 75 min → cron scan needs SQL
on a datetime column). D1 migrations give schema history. JSON columns for
scoring/roster avoid prematurely modeling ESPN's ~50 stat categories as
rows — downstream features read the map whole.

**Alternatives considered**: KV (no cross-key queries — the cron scan and
uniqueness constraints become manual); Durable Object storage (belongs to
004's per-draft rooms, not account data); external Postgres (violates
simplicity, adds a network dependency).

## 4. Sessions & passwordless email sign-in

**Decision**: Sign-in = email one-time code (6 digits) with an equivalent
magic link (same token). Verifying sets an HttpOnly, Secure, SameSite=Lax
session cookie containing an HMAC-SHA256-signed token (account id + expiry,
30 days). Stateless — no session table; sign-out clears the cookie. Login
codes are stored hashed with a 10-minute expiry and are single-use.

**Rationale**: Matches the clarified requirement (passwordless email, no
passwords stored). Stateless sessions need zero storage and satisfy the
spec's sign-out scenario (device loses access when cookie cleared). WebCrypto
HMAC is native to Workers — no JWT library needed.

**Alternatives considered**: Server-side session table (adds writes/reads
for no required capability — no forced-revocation requirement exists);
third-party auth (Clerk/Auth0 — external dependency and account data leaves
our control, against simplicity and privacy posture); passkeys (rejected in
clarification).

## 5. ESPN cookie encryption & secret hygiene

**Decision**: Encrypt `espn_s2` and `SWID` with AES-256-GCM (WebCrypto),
key from a Worker secret (`CREDENTIAL_KEY`, 32-byte base64), random 12-byte
IV per record, ciphertext+IV in D1. Decrypt only inside ESPN-call paths.
API returns only `{ swid_masked, status, last_validated_at }`. A logging
wrapper redacts `espn_s2`/`SWID` patterns defensively; ESPN requests send
cookies via the `Cookie` header only (never URLs).

**Rationale**: Constitution security constraints require encryption at
rest, no client exposure after entry, no logging, no URLs. GCM gives
integrity as well as confidentiality; WebCrypto is native.

**Alternatives considered**: Plaintext columns (violates constitution);
per-account derived keys (key-management complexity without a threat-model
win at this scale — the DB and the key live in the same trust domain
either way).

## 6. Email delivery

**Decision**: A one-method `EmailSender` interface with two adapters:
`console` (dev/test — code printed to `wrangler dev` logs) and **Resend**
(production; single HTTPS POST, API key as Worker secret). Provider choice
is config, not code.

**Rationale**: Magic-link mail is one templated message; a thin adapter
keeps the only third-party service swappable (e.g. to Cloudflare Email
Service later) without touching auth logic.

**Alternatives considered**: Cloudflare Email Sending (attractive —
Workers-native binding; kept as a drop-in adapter candidate, but Resend's
plain HTTP API is the lowest-friction start and works from local dev);
SMTP via third-party relay (Workers can't speak raw SMTP sockets).

## 7. ESPN fantasy API integration

**Decision**: Read-only client against
`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}`
using query `?view=mSettings&view=mTeam` for settings/teams and
`?view=mDraftDetail` for draft order once published. Cookies sent for all
requests. Team auto-match: the user's `SWID` equals a `members[].id` GUID;
the team whose owner list contains that member is "mine". League URL paste →
extract `leagueId` (and season if present) by regex. Error mapping: HTTP 401
→ credentials invalid; 404 → league not found; wrong `seasonId`/game →
distinct validation errors (FR-012). Fixtures recorded from real leagues
(sanitized) drive tests; client enforces a minimum 30-second interval
between full syncs of the same league (polite polling; the 5-minute cron
sets the pace inside the pre-draft window).

**Rationale**: These are the endpoints/views the ESPN web app itself uses
(the constitution's baseline assumption); stat-category-level scoring
(`settings.scoringSettings.scoringItems`) preserves the league-currency
principle for feature 002. Endpoints verified against the current season
during implementation (ESPN shuffles hosts between seasons — the base URL
is a single config constant).

**Alternatives considered**: Community wrappers (espn-api, Python-only;
JS ports unmaintained — a thin bespoke client over 2 endpoints is smaller
than auditing a dependency); scraping league pages (fragile, more load).

## 8. Pre-draft window auto-sync scheduling

**Decision**: Worker Cron Trigger every 5 minutes. Handler queries D1 for
league connections with `draft_at` between now−15 min and now+75 min and
draft not yet marked started/complete, then re-syncs each (settings +
mDraftDetail), capturing draft order and draft-time changes.

**Rationale**: Directly satisfies FR-019 and SC-004 (order reflected ≤ 5 min
after publication). A stock cron + SQL scan is the simplest thing that works
(constitution VIII) at ≤ 5 leagues/account scale; the now−15 lower bound
also catches drafts that just started late.

**Alternatives considered**: Durable Object alarm per league (right shape
for 004's live draft rooms, premature here); Cloudflare Queues (nothing to
queue at this volume); client-side polling while the page is open (fails
the "without user action" requirement when no page is open).

## 9. Testing strategy

**Decision**: Vitest + `@cloudflare/vitest-pool-workers` (runs tests inside
workerd with real D1/crypto bindings). Layers: unit (crypto round-trip,
ESPN parsers, SWID team-matching, league-URL extraction), contract (every
endpoint in contracts/api.md, including error codes and the
no-secrets-in-responses rule), integration (connect→sync→dashboard flow
with a stubbed ESPN fetch serving fixtures; cron window scan). A grep-style
test asserts no response or log path emits `espn_s2` values (SC-005).

**Rationale**: The workers pool executes against the production runtime
semantics (D1, WebCrypto) rather than Node shims — highest fidelity per
unit of setup.

**Alternatives considered**: Miniflare-only Jest setup (older path, weaker
D1 parity); live-ESPN tests in CI (nondeterministic, needs real secrets —
manual quickstart validation covers it instead).

## 10. WebSockets (ratified decision, deferred use)

**Decision**: No WebSocket usage in 001. The ratified real-time transport
enters at 004-draft-monitor (Durable Object per draft room).

**Rationale**: 001 has no push requirement; dashboard freshness is
request-time. Adding WS now would be speculative structure (VIII).
