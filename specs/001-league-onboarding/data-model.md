# Data Model: League Onboarding (001)

Store: Cloudflare D1 (SQLite). All timestamps are UTC ISO-8601 strings
(`TEXT`); display conversion to the user's time zone happens client-side
(FR-023). Migrations live in `migrations/`.

## Entity: accounts

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | UUID v4 |
| email | TEXT | UNIQUE, NOT NULL | Lowercased at write; sign-in identity (FR-001) |
| created_at | TEXT | NOT NULL | |
| last_login_at | TEXT | NULL | |

Deleting an account cascades to all child rows (FR-009).

## Entity: login_tokens

Single-use passwordless sign-in tokens (code + magic link share one row).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | UUID |
| email | TEXT | NOT NULL | Target of the sign-in attempt (account may not exist yet — first verify creates it) |
| code_hash | TEXT | NOT NULL | SHA-256 of 6-digit code |
| link_hash | TEXT | NOT NULL | SHA-256 of magic-link token (128-bit random) |
| expires_at | TEXT | NOT NULL | issue + 10 min |
| consumed_at | TEXT | NULL | Set on successful verify; non-null ⇒ unusable |
| created_at | TEXT | NOT NULL | |

Validation: ≤ 3 outstanding tokens per email (rate limit); verify attempts
per token capped at 5.

## Entity: espn_credentials

Exactly one active ESPN cookie pair per account (clarification Q4).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| account_id | TEXT | PK, FK → accounts.id ON DELETE CASCADE | 1:1 with account |
| s2_ciphertext | BLOB | NOT NULL | AES-256-GCM(espn_s2), 12-byte IV prepended |
| swid_ciphertext | BLOB | NOT NULL | AES-256-GCM(SWID) |
| swid_masked | TEXT | NOT NULL | e.g. `{ABC1…89EF}` — the only displayable form (FR-006) |
| status | TEXT | NOT NULL, CHECK IN ('working','failing') | See state machine below |
| last_validated_at | TEXT | NULL | Last successful ESPN call using this pair |
| updated_at | TEXT | NOT NULL | |

Normalization before validation (FR-004): trim whitespace/quotes; SWID
upper-cased and wrapped in `{}` if braces missing.

**Status state machine**: `working` → `failing` on any ESPN 401/403 using
the pair (FR-008; affected leagues display "credentials need refresh");
`failing` → `working` only via successful re-validation after replacement
(FR-007). Replacement re-validates every connected league.

## Entity: league_connections

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | UUID |
| account_id | TEXT | FK → accounts.id ON DELETE CASCADE, NOT NULL | |
| espn_league_id | TEXT | NOT NULL | |
| season | INTEGER | NOT NULL | Current season only (assumption) |
| my_team_id | INTEGER | NOT NULL | ESPN team id; required — no observer mode (clarification Q2) |
| team_match_source | TEXT | NOT NULL, CHECK IN ('auto','manual') | FR-014 |
| created_at | TEXT | NOT NULL | |
| last_sync_at | TEXT | NULL | Last **successful** sync (FR-017) |
| last_sync_status | TEXT | NOT NULL, CHECK IN ('ok','failed','pending') | FR-020: 'failed' keeps serving snapshot labeled with age |

Constraints: UNIQUE(account_id, espn_league_id, season) — a league can't be
connected twice by the same account; ≥ 5 connections per account supported
(FR-011, no hard cap). A connection row is created only after validation
passes and a team is identified — no partial connections (edge case:
ESPN unreachable on connect).

## Entity: league_snapshots

Latest synced configuration per connection (1:1; overwritten each successful
sync). History is not retained (constitution VIII — nothing consumes it).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| connection_id | TEXT | PK, FK → league_connections.id ON DELETE CASCADE | |
| captured_at | TEXT | NOT NULL | Drives "last synced"/staleness label |
| league_name | TEXT | NOT NULL | |
| team_count | INTEGER | NOT NULL | |
| scoring_json | TEXT | NOT NULL | Raw map: stat category id → point value, plus scoring format metadata (constitution III — stored losslessly for feature 002) |
| roster_json | TEXT | NOT NULL | Slot composition: position slot → count (starters, bench, IR) |
| draft_json | TEXT | NOT NULL | `{ type, scheduled_at, order: [teamId…] \| null, started, completed }` — order null until ESPN publishes (~T-60 min) |
| teams_json | TEXT | NOT NULL | `[{ espn_team_id, name, manager_names }]` (FR-016) |

## Relationships

```text
accounts 1 ──── 1 espn_credentials
accounts 1 ──── * league_connections 1 ──── 1 league_snapshots
login_tokens (keyed by email; pre-account)
```

## Sessions (not a table)

Stateless signed cookie: `dg_session = base64(payload).hmac` where payload =
`{ account_id, exp }` (30 days), HMAC-SHA256 with Worker secret
`SESSION_SECRET`. HttpOnly, Secure, SameSite=Lax, Path=/. Sign-out clears
the cookie (spec US4 scenario 2). No server-side session state.

## Derived views (query shapes, not tables)

- **Dashboard** (FR-021): connections joined to snapshots, ordered by
  `draft_json.scheduled_at` ascending NULLS LAST.
- **Pre-draft cron scan** (FR-019): connections where `scheduled_at`
  ∈ [now − 15 min, now + 75 min] and `draft_json.completed = false`.
  `draft_json.scheduled_at` is duplicated into an indexed generated column
  `draft_at` for this query.
