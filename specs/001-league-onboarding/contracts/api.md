# API Contract: League Onboarding (001)

Base path `/api`. JSON request/response bodies. All endpoints except
`/api/auth/*` require the `dg_session` cookie → `401 {"error":"unauthenticated"}`
otherwise. Validation errors → `422 {"error":"<code>", "message":"<human text>"}`.
ESPN cookie values never appear in any response body, header, or URL (SC-005).

Errors use stable machine codes (`error`) plus a human `message` that states
what to do next (SC-006).

## Auth

### POST /api/auth/request
Start passwordless sign-in. Creates the account on first verify, not here.

- Body: `{ "email": string }`
- 204 on accept (always 204 for valid email syntax — no account enumeration)
- 422 `invalid_email`; 429 `rate_limited` (> 3 outstanding tokens)
- Side effect: email with 6-digit code + magic link (10-min expiry, single use)

### POST /api/auth/verify
- Body: `{ "email": string, "code": string }`
- 200 `{ "account": { "id", "email" } }` + `Set-Cookie: dg_session=…` (30 d)
- 422 `invalid_code` (wrong/expired/consumed; ≤ 5 attempts per token)

### GET /api/auth/magic?token=…
Magic-link variant of verify. On success sets cookie and 302-redirects to `/`.
Failure 302-redirects to `/signin?error=expired_link`. (Token is opaque,
single-use, unrelated to ESPN secrets — allowed in URL.)

### POST /api/auth/signout
- 204; clears session cookie.

## Account

### DELETE /api/account
FR-009. Deletes account, credentials, connections, snapshots.
- 204. Also clears session cookie.

## ESPN credentials

### PUT /api/credentials
Store/replace the account's cookie pair (FR-004/005/007). Normalizes input,
validates against ESPN before persisting; on replace, re-validates all
connected leagues.

- Body: `{ "espn_s2": string, "swid": string }`
- 200 `{ "status": "working", "swid_masked": string, "last_validated_at": string, "leagues_revalidated": number }`
- 422 `espn_rejected` (ESPN 401/403 — values not stored), `malformed_credentials`
- 502 `espn_unreachable` (nothing stored; retryable)

### GET /api/credentials
- 200 `{ "present": boolean, "status": "working"|"failing"|null, "swid_masked": string|null, "last_validated_at": string|null }`

## Leagues

### POST /api/leagues
Connect a league (FR-010/012/014). `league_ref` is an ESPN league ID or a
pasted ESPN league URL.

- Body: `{ "league_ref": string }`
- 201 → League resource (below), when validation passes and team auto-match succeeds
- 409 `team_choice_required` `{ "connect_token": string, "teams": [{ "espn_team_id", "name", "manager_names" }] }`
  — league is valid but auto-match failed; follow with POST /api/leagues/connect/complete
- 422 `no_credentials` (FR-013), `league_not_found`, `not_football`,
  `wrong_season`, `already_connected`, `unparseable_ref`
- 422 `espn_rejected` (credentials failing — also flips credential status)
- 502 `espn_unreachable` (no partial connection created)

### POST /api/leagues/connect/complete
Complete a `team_choice_required` connection. No connection row exists during
this flow — all state travels in the short-lived signed `connect_token` from
the 409 response (hence no `:id` in the path). Choosing "none of these" is a
client-side dead end: the league cannot be connected (no observer mode) — the
client simply abandons the token; nothing is stored server-side.

- Body: `{ "connect_token": string, "espn_team_id": number }`
- 201 → League resource
- 422 `invalid_team`, `expired_connect_token`

### GET /api/leagues
Dashboard list (FR-021), ordered by soonest upcoming draft first (nulls last).

- 200 `{ "leagues": [LeagueSummary] }`

```jsonc
// LeagueSummary
{
  "id": "…",                     // connection id
  "espn_league_id": "12345",
  "season": 2026,
  "name": "Naperville Legends",
  "team_count": 12,
  "my_team": { "espn_team_id": 4, "name": "Jai's Giants" },
  "scoring_summary": "0.5 PPR · 16 slots",   // derived: reception points per catch if scored ("PPR"/"0.5 PPR"/"Standard"), else "Custom scoring"; "·" + total starting-slot count
  "draft": { "type": "snake_live_online", "scheduled_at": "…", "order_published": false, "supported": true },
  "last_sync_at": "…",
  "sync_status": "ok" | "failed" | "pending",
  "credentials_status": "working" | "failing"   // FR-008 surface
}
```

### GET /api/leagues/:id
Full detail (FR-022): LeagueSummary plus `scoring_rules` (every stat
category with label and point value), `roster_slots`, `teams`, `draft.order`
(list of team ids, null until published), `snapshot_age_seconds`.

- 200 League detail; 404 `unknown_league`

### POST /api/leagues/:id/sync
Manual re-sync (FR-018).

- 200 → refreshed League detail
- 200 with `"sync_status": "failed"` + `"warning"` when ESPN unreachable —
  stale data retained and labeled (FR-020); never a 5xx for a failed refresh
  of an existing league

### DELETE /api/leagues/:id
FR-015. Removes connection + snapshot only.
- 204

## Scheduled (not HTTP)

Cron every 5 min → pre-draft window scan (research.md §8): re-syncs
connections with `draft_at` ∈ [now−15 m, now+75 m] not yet completed.
Behavior identical to POST …/sync including failure handling.

## Cross-cutting guarantees

- Per-account isolation: every query is scoped by the session's account id;
  cross-account access is 404, never 403 (no existence leak) (FR-003).
- Time values in responses are UTC ISO-8601; client renders local (FR-023).
- No endpoint echoes `espn_s2` or unmasked `SWID`; contract tests assert
  this on every response (SC-005).
