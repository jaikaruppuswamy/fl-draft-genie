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
SELECTED <teamId> <playerId> <field3> [{memberSWID}]\n
```

| Field | Meaning | Evidence |
|---|---|---|
| 1 | **team id** — CONFIRMED | Matches the oracle's `teamId` on **70/70** frames. Independently, the human-paced opening rounds ran `[5,2,1,3,6,4]` then **exactly its reverse** — the snake reversal that distinguishes team id from pick number |
| 2 | **player id** — CONFIRMED | Joins 1:1 to the oracle. Large positive ints, **and legitimately negative** — all six D/ST picks carry ids near `-16000`. Never filter on sign |
| 3 | **UNRESOLVED** | See below. Cross-checked against the oracle it matches `lineupSlotId` 25%, `roundPickNumber` 10%, `roundId` 7%, `overallPickNumber` 0% |
| 4 | **member SWID, optional** — CONFIRMED | Present on 34 of 70 frames; every one matches that team's `JOINED` SWID (34 match, 0 mismatch). Absent on autodraft picks |

### Field 3 is unresolved, and nothing may depend on it

An earlier reading of this document called field 3 the **round**. **That was
wrong**, and the independent oracle (FR-019b) is what caught it — which is
precisely the job it exists to do. The value distribution (exactly six of each
value 1–12 in a 6-team, 12-round draft) makes several interpretations look
plausible; none survives the join:

- it is **not** the round — matches `roundId` on 5 of 70
- it is **not** any pick ordinal — 0/70 against `overallPickNumber`
- it is **not** simply the lineup slot — 18/70, and those matches are almost
  entirely round 1, where a team's first RB happens to land in the RB slot

**Re-tested on a SECOND independent live draft (2026-08-04), same result.** 69
picks against ESPN's own post-draft record: `lineupSlotId` 23%, `roundId` 5%,
`roundPickNumber` 5%, `overallPickNumber` 0% — proportions almost identical to
the first draft. A third hypothesis, *"the team's Nth pick in draft order"*, was
also tested and **rejected at 4/69**.

What the two drafts do establish: field 3 is **real and stable**, not noise. The
ledger's `+12` equals `SELECTED`'s field 3 on **27/27** in the first draft and
**28/28** in the second, so both representations carry the same value.

Best remaining explanation, still a hypothesis: the lineup slot assigned **at
pick time**, before ESPN normalises the roster after the draft — which would
explain why it matches the post-draft `lineupSlotId` for early-round picks (a
team's first RB lands in the RB slot) and diverges later. There is no
independent source for "slot at pick time", so it cannot be confirmed. Per spec
US1 AS3 it stays an **opaque integer** that nothing interprets.

**Nothing needs it.** FR-005a's stable identity is the **player id**, unique
within a draft and confirmed to join cleanly to the oracle. Round and overall
pick number are available from the ledger and from the post-draft record. If a
later capture settles field 3, this table is where it gets recorded.

**There is no pick number in `SELECTED`** — confirmed against the oracle.

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
INIT <base64> <2048 '#' characters>\n
```

**The frame is not just base64.** It carries a second space-separated field: a
block of exactly 2048 `#` characters, whose meaning we do not interpret. A
decoder that passes everything after `INIT ` to `atob` throws in the browser
(*"The string to be decoded is not correctly encoded"*) — take the **first
whitespace-delimited token only**.

This did not surface in unit tests because Node's `Buffer.from(s, "base64")`
silently ignores characters outside the alphabet while the browser's `atob`
rejects them. Any test helper standing in for `atob` must be **strict**, or it
will pass against payloads the real tap cannot decode.

The full pick ledger. Verified to contain **zero strings and zero GUIDs** (64%
null bytes, fixed-width integer records), so its blob is safe to commit and
carries no names or SWIDs. It is a **fixed-size pre-allocated array**: 7,464
bytes with no picks vs 7,472 with 27 filled.

**Sent on every connect**, and it is authoritative: of the picks made before a
mid-draft reconnect, **27/27 appeared in the re-sent ledger and 0/43 of the
later ones did**. The incremental stream lost 2 of 72 picks across a page
reload; the ledger is what recovers them. This is why FR-005 makes the ledger
non-discretionary and 005 FR-012 makes it the source of truth.

### Ledger record layout — RESOLVED (T016, against the oracle)

72 fixed-width records in one pre-allocated array, **stride 45 bytes**,
big-endian int32 fields:

| Offset | Field | Confidence |
|---|---|---|
| `+0` | `teamId` | confirmed — matches the oracle on all 29 filled records |
| `+4` | `overallPickNumber` | confirmed — 1-based and dense, all 29 agree |
| `+8` | `playerId` | confirmed — `-1` is the empty sentinel; **negative values are real** (D/ST) |
| `+12` | *unresolved* | equals `SELECTED`'s field 3 on **27/27**, so it is a real, stable protocol field — but its meaning is still unknown and nothing depends on it |

`roundId` and `roundPickNumber` do **not** appear as int32 anywhere in the
record. They are derivable from `overallPickNumber` plus the team count and the
snake rule, so ESPN appears not to transmit them.

**The array offset is NOT constant and must never be hardcoded.** It was 2070 in
the pre-draft ledger and 2078 in the mid-draft one — *within the same draft* —
because the prefix ahead of it grows. `tap/decode.ts` locates the array by its
invariant instead (a run of records numbered 1, 2, 3, …), which generalises
across league shapes and fails loudly if the layout changes (FR-017).

Per research §2 the reader is **ours**, never a port of ESPN's: their
`readDouble`/`readFloat` discard the bytes and return `Math.random()`.

## What 005 must not assume

- **`SELECTED`'s third field is UNRESOLVED. Do not treat it as the round.**
  An earlier revision of this section asserted it *was* the round. That reading
  was **disproven** by the independent oracle: it agreed on only 5 of 70 picks.
  It is a real, stable protocol field — the ledger's `+12` equals it on 27/27 —
  but its meaning is unknown, `tap/filter.ts` carries it opaquely as `slot3`,
  and **no requirement in 005 may depend on it**. In particular it is not a
  valid pick identity (FR-005a) and cannot be used to derive round or
  pick-in-round; derive those from `overallPickNumber` and the league's team
  count instead.
- **There IS a fourth field carrying a member SWID** on `SELECTED`, which
  ESPN's own client parser did not suggest. It is stripped at the source and
  never relayed.
- **The ledger's internal offsets ARE resolved** (T016): 72 fixed-width records
  at stride 45 — `+0` teamId, `+4` overallPickNumber, `+8` playerId (`-1` is the
  empty sentinel), `+12` the same unresolved field as above. What is *not*
  fixed is the array's byte offset, which varies by league shape and within a
  single draft; locate it by invariant, never by constant.
- **Player ids may be negative** (D/ST). Any filter on sign is wrong.
- **Unrecognised messages are reported, not dropped.** 005 will receive
  `kind: "status"` messages saying the tap saw something it did not understand;
  that is a signal to surface, not noise to ignore.
