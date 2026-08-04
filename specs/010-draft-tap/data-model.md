# Data Model: Draft Tap (010)

Three stores, each with a distinct job:

- **Script-manager storage** — the tap's buffer and pairing credential. Never
  `espn.com` localStorage, which is ESPN's own bucket, readable by ESPN's JS and
  wiped by "clear site data".
- **D1** (migration `0006_tap.sql`) — pairing credentials, server side.
- **Nothing in the page.** The tap adds no storage to ESPN's origin.

---

## Relay Message (the wire contract 005 consumes)

Produced only after **decode → filter**, never from the wire form (FR-006c).

```jsonc
{
  "v": 1,                          // contract version; also the tap's build version
  "install": "uuid",               // stable per install
  "session": "uuid",               // fresh per PAGE LOAD — not sessionStorage, which
                                   // is cloned on tab duplication and would collide
  "seq": 412,                      // monotonic within (install, session)
  "epoch": 2,                      // timing epoch; bumped when the clock anchor moves >2s
  "observed_at": "2026-08-30T23:14:07.221Z",   // FR-006b — load-bearing downstream
  "transport": "ws",               // ws | sse — normalisation differs, so record it
  "league": { "espn_league_id": "1064865483", "season": 2026 },
  "kind": "pick" | "ledger" | "status",
  "payload": { … }                 // numeric ids only
}
```

**Allowlisted payload fields** (FR-006a). Anything not on this list is dropped
before the message exists:

| Field | Notes |
|---|---|
| player id | integer; **may be negative** (D/ST), so never filter on sign |
| team id | integer |
| lineup slot id | integer |
| pick number / ordinal | from the ledger where present; derived for incremental frames |
| round, pick-in-round | where present |
| keeper / autodraft flags | booleans |
| observation time, seq, epoch | the tap's own metadata |

**Explicitly forbidden**, in payload or anywhere else: manager names, display
names, team names, member identifiers (numeric *or* brace-form), chat text, free
text of any kind, and **`location.href`** — the draft-room URL carries the
owner's SWID as a query parameter (research §3).

### `kind: "ledger"`

The full pick set ESPN re-supplies on page load and reconnect. 005 FR-012 makes
this the source of truth, so it MUST be distinguishable from an incremental
message and MUST be relayed **before** any incremental frame from the same
session.

Favourable property: the ledger blob contains **no strings at all** —
`readUTF()` is never called in ESPN's transcoder tree — so its identity exposure
is numeric ids only.

### `kind: "status"`

Tap-side state changes 005 surfaces to the user: paired, relaying, buffering,
unreachable, version-mismatch, **unrecognised-message**, draft-finished. Carries
no draft data.

---

## Buffer Entry (script-manager storage)

Keyed `dg:buf:<install>:<session>`, with `dg:meta:<install>:<session>` holding
`{ league, season, lastHeartbeatMs, deliveredThroughSeq }`. Per-session keys
mean two tabs never write the same key, so no lock is needed.

**Holds filtered Relay Messages, never wire frames.** Decode → strip → buffer →
send. Buffering the raw form and stripping on send would write unstripped
identifiers to disk, where they outlive the tab and are invisible to any
inspection of transmitted traffic.

**Truncation rule**: entries are removed **only** on a read acknowledgement
carrying `accepted_through`. Never on an unacknowledged send — `sendBeacon`
returns only a boolean and `GM_xmlhttpRequest`'s post-unload behaviour is
undocumented. A duplicate is absorbed by FR-010's dedup; a lost pick is not
recoverable.

**Durability ranking** (state this, don't imply it): ESPN's ledger is the
*primary* recovery mechanism — every page load re-supplies it. The buffer is
*secondary*, covering the one window the ledger cannot: picks observed while
Draft Genie is unreachable in a tab that is never reloaded again. That ranking
is what makes an occasional lost buffer write survivable rather than a spec
violation.

---

## Pairing (D1 `tap_pairings`)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | |
| account_id | TEXT | NOT NULL REFERENCES accounts(id) ON DELETE CASCADE | Per-user, matching the `0001_init.sql` convention |
| token_hash | TEXT | NOT NULL UNIQUE | The token itself is never stored |
| install_id | TEXT | | Bound on first use, so one token is not shared across machines |
| created_at | TEXT | NOT NULL | |
| last_used_at | TEXT | | Drives the "not relaying" surface |
| expires_at | TEXT | NOT NULL | FR-014a requires a stated lifetime |
| revoked_at | TEXT | | Revocation stops relay within one message |

`CREATE INDEX idx_tap_pairings_account ON tap_pairings (account_id);`

**Scope** (reconciling 005 FR-007d with 010 FR-014): the credential is
**per-user**; the league is carried **per-message**. One install serves every
connected league, and the ingest scopes each accepted message to one league
connection it verifies the account owns. Both specs then describe the same
thing.

**Blast radius if leaked**: append draft messages for that account's own
leagues. Never read league data, never touch ESPN, never any other account.

---

## Tap Status (in-memory, surfaced in the page and relayed as `kind: "status"`)

```text
uninstalled → not-paired → paired ─→ watching ─→ relaying ─→ draft-finished
                                          │  ▲        │
                            not-a-draft-page │        ├→ buffering (unreachable)
                                             │        ├→ version-rejected
                                             └────────┴→ INCOMPATIBLE (loud)
```

Two states exist specifically to prevent silent failure:

- **INCOMPATIBLE** — the message shape stopped matching what the tap
  understands, *or* the page-world preflight failed. The latter matters because
  in an isolated world `window.WebSocket` is not the page's and the tap would
  observe nothing while appearing perfectly healthy.
- **draft-finished vs watching** — SC-014 forbids idle and dead looking the
  same. Where the tap cannot tell whether a draft is still running, it says so
  rather than going quiet.

**Unrecognised ≠ discarded.** A message matching a *known* non-draft kind
(chat, presence, `PONG`) is dropped silently; anything **unrecognised** is
counted and reported (FR-017a). ESPN's own parser has no `default:` branch — it
silently drops verbs it does not know — so our behaviour deliberately differs.
