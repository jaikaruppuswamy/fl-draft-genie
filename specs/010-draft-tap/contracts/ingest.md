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
  "league": { "espn_league_id": "9999999999", "season": 2026 },
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

## ESPN frame shapes — established from the US1 capture (2026-08-04)

Derived from a real 12-round, 6-team snake draft (70 picks, 617 frames). Every
field below was confirmed against observed data; nothing here is inferred from
ESPN's client naming. Fixture: `tests/fixtures/tap/capture-2026.jsonl`.

```
SELECTED <teamId> <playerId> <round> [{memberSWID}]\n
```

| Field | Meaning | Evidence |
|---|---|---|
| 1 | **team id** | Values 1–6 in a 6-team league; the human-paced opening rounds ran `[5,2,1,3,6,4]` then **exactly its reverse** `[4,6,3,1,2,5]`. The snake reversal is what distinguishes team id from pick number, and it did |
| 2 | **player id** | Large positive ints, **and legitimately negative** — all six teams took a D/ST in round 7 with ids near `-16000`. Never filter on sign |
| 3 | **round** | Values 1–12 in a 12-round draft, ~6 frames per value. *Not* a lineup slot — an earlier reading of this was wrong and the round grouping corrected it |
| 4 | **member SWID, optional** | Present on 34 of 70 frames; every one matches that team's `JOINED` SWID exactly (34 match, 0 mismatch). Absent on autodraft picks |

**There is no pick number in `SELECTED`.** FR-005a's stable identity is
therefore the **player id**, which is unique within a draft. An overall ordinal
is available only from the ledger.

**Field 4 is the reason FR-006a exists.** Prior research concluded SWIDs
appeared only in `CHAT`/`JOINED`/`LEFT`/`ACL`; they are in the **pick frame
itself**. Relaying frames as-is would ship a leaguemate's SWID with every human
pick. The tap MUST drop field 4 before transmission.

Other observed frames — all discarded by FR-006, none relayed:

| Verb | Shape | Note |
|---|---|---|
| `JOINED` | `JOINED <teamId> {memberSWID}` | carries a SWID |
| `TOKEN` | `TOKEN <game>:<league>:<team>:{memberSWID}:<n>` | carries the **owner's own** SWID |
| `CLOCK`, `SELECTING`, `AUTOSUGGEST`, `AUTODRAFT`, `STATE` | — | draft-adjacent but not picks; `SELECTING`/`CLOCK` may later serve on-the-clock signalling |
| `PONG` | keep-alive | **inbound** keep-alive — `PING` is client→server only and we never send it. Belongs in FR-017a's known-non-draft allowlist |

```
INIT <base64>\n
```

The full pick ledger. Verified to contain **zero strings and zero GUIDs** (64%
null bytes, fixed-width integer records), so its blob is safe to commit and
carries no names or SWIDs. It is a **fixed-size pre-allocated array**: 7,464
bytes with no picks vs 7,472 with 27 filled.

**Sent on every connect**, and it is authoritative: of the picks made before a
mid-draft reconnect, **27/27 appeared in the re-sent ledger and 0/43 of the
later ones did**. The incremental stream lost 2 of 72 picks across a page
reload; the ledger is what recovers them. This is why FR-005 makes the ledger
non-discretionary and 005 FR-012 makes it the source of truth.

**Field offsets within the ledger are still unresolved** — decoding it is
T016's job, and per §2 the reader must be ours, never a port of ESPN's (whose
`readDouble`/`readFloat` return `Math.random()`).

## What 005 must not assume

- **Field meanings are now established** (see the section above, US1 capture
  2026-08-04) — with one correction to ESPN's own naming: `SELECTED`'s third
  field is the **round**, not a lineup slot, and there is a **fourth field
  carrying a member SWID** that the client's parser did not suggest. SC-000 is
  satisfied for `SELECTED`; the **ledger's internal offsets remain unresolved**
  and no requirement may depend on them until T016 decodes it.
- **Player ids may be negative** (D/ST). Any filter on sign is wrong.
- **Unrecognised messages are reported, not dropped.** 005 will receive
  `kind: "status"` messages saying the tap saw something it did not understand;
  that is a signal to surface, not noise to ignore.
