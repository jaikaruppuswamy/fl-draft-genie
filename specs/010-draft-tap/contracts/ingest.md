# Ingest Contract: Draft Tap (010) → Draft Genie

This is the seam between 010 and 005. 005 is specified and testable against
**this document plus a recorded batch file**, with no browser and no live draft.

Message shape: [data-model.md](../data-model.md#relay-message-the-wire-contract-005-consumes).

---

## Routing (three traps, all load-bearing)

1. **Mount `/api/tap/*` BEFORE `app.use("/api/*", …)`** in
   [app.ts:34](src/api/app.ts:34). That middleware is a bare prefix match, so a
   tap POST reaching it first returns `401 unauthenticated` and no amount of
   correct token handling fixes it.
2. **CORS preflight must exist.** A cross-origin POST from
   `https://fantasy.espn.com` triggers an `OPTIONS` preflight. `src/` has **no
   Access-Control handling today**. A contract test that asserts only the POST
   leaves the relay failing on draft day for a reason nothing covers.
3. **Do not add a 403-on-unknown-origin guard.** Hono's CORS *omits* rather than
   *rejects* on an unlisted origin, which is exactly what the
   `GM_xmlhttpRequest` path needs.

## Authentication

`Authorization: Bearer <pairing token>` — per-user, revocable, rotatable, with a
stated expiry (FR-014a). Never an ESPN cookie; the tap never reads one.

The credential's transport MUST be **identical on every path**, including any
unload/last-gasp flush. `sendBeacon` cannot carry custom headers, so if it is
ever used the token would fall into the body or a cookie and revocation
semantics would diverge — decide once, not per call site.

---

## POST /api/tap/batch

```jsonc
{
  "v": 1, "install": "uuid", "session": "uuid",
  "league": { "espn_league_id": "1064865483", "season": 2026 },
  "messages": [ /* Relay Messages, ascending seq, ≤ 200 per batch */ ]
}
```

**Response 202**

```jsonc
{ "accepted_through": 412, "session_known": true, "server_time": "…" }
```

`accepted_through` is the **only** signal that permits buffer truncation. A
batch that is entirely duplicate is still `202` with the highest known seq —
duplicates are expected (FR-010) and are not an error.

**Errors**, each distinguishable so FR-016 can report the right thing:

| Status | Meaning | Tap behaviour |
|---|---|---|
| 401 | token invalid, expired or revoked | stop relaying, `not-paired`, keep buffer |
| 403 | league not owned by this account | drop those messages, report loudly — a wrong-tab or stale-script bug |
| 409 | contract version unsupported | `version-rejected`, keep buffer, prompt update |
| 429 | rate limited | back off using `Retry-After`, keep buffer |
| 5xx / unreachable | server side | `buffering`, event-driven retry |

`Retry-After` is readable through `GM_xmlhttpRequest` without
`Access-Control-Expose-Headers`.

## POST /api/tap/status

Tap-side state changes with no draft data. Feeds 005's FR-007c "not receiving
picks" detection and the diagnostic surface.

## GET /api/tap/health

Unauthenticated liveness for the install walkthrough, so the owner can confirm
the tap reaches Draft Genie **without waiting for a draft** (FR-021, SC-006).

---

## Ordering, identity and duplicates

- **Ordering** is `(install, session, seq)`. `session` is fresh per **page
  load** — never derived from `sessionStorage`, which is cloned on tab
  duplication and would produce colliding sequences from two live relays.
- **Identity** is the pick's own identity from the payload, not `seq`. Two tabs
  relaying one draft produce two sequences of the same picks; 005 deduplicates
  on pick identity (005 FR-012), which is why FR-005a requires that identity to
  be present and stable across both the ledger and the incremental frames.
- **The ledger arrives first** in any session, before incremental frames, so 005
  always has an authoritative baseline to reconcile against.
- **Timing epochs**: `observed_at` values are comparable **only within one
  `epoch`**. The epoch increments when the tap re-anchors its clock (sleep,
  resume). 005 must not treat stamps across epochs as one timeline —
  `performance.now()` stalls across sleep while `Date.now()` jumps, so a
  page-load-anchored stamp silently runs late afterwards.

## What 005 must not assume

- **Field meanings are US1's output, not this document's.** ESPN's own parser
  names `SELECTED`'s fields teamId/playerId/slotId and the ledger carries a pick
  number, but that is the client's model of the server, not proof. This contract
  is finalised only after the capture confirms it (spec SC-000).
- **Player ids may be negative** (D/ST). Any filter on sign is wrong.
- **Unrecognised messages are reported, not dropped.** 005 will receive
  `kind: "status"` messages saying the tap saw something it did not understand;
  that is a signal to surface, not noise to ignore.
