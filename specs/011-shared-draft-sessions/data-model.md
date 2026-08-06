# Phase 1 Data Model: Shared Draft Sessions

**Feature**: 011-shared-draft-sessions | **Date**: 2026-08-06

**No new tables.** Every change is to how existing rows are *scoped* or *read*.
That is the point: the boundary was drawn in the wrong place, not missing.

---

## 1. What changes, and what does not

| Existing shape | Change |
|---|---|
| `tap_batches` | **None.** Already carries `account_id` **and** `connection_id`. §6's fix reads the former instead of the latter. |
| `tap_pairings` | Gains nothing structural; enablement is created by acknowledgement rather than by a copied token. Already cascades from `accounts` only — a league disconnect never touched it (verified 2026-08-06). |
| `draft_sessions` | **None.** Still one row per connection. Fan-out means several rows are armed for one league, which the table already permits. |
| `league_connections` | **None.** |
| Durable Object addressing | **Unchanged** — `connectionId:season`. Fan-out avoids a re-key entirely (research §1). |

---

## 2. `SessionScope` — the split made explicit

Today one shape carries both kinds of fact. The feature does not change the
fields; it changes which are allowed to come from the relaying manager.

| Field | Kind | Source after this feature |
|---|---|---|
| `espnLeagueId` | **shared** | the draft |
| `season` | **shared** | the draft |
| `order` | **shared** | the draft (derived from picks — see 008's finding) |
| `totalPicks` | **per-manager** | each manager's own snapshot |
| `accountId` | **per-manager** | the viewing manager |
| `connectionId` | **per-manager** | the viewing manager |
| `myTeamId` | **per-manager** | the viewing manager |

`totalPicks` sits on the per-manager side deliberately: two managers recorded 11
and 12 rounds for the same draft (observed 2026-08-06). Each session uses its
own, and the disagreement is surfaced (FR-005) rather than one manager's stale
sync silently reshaping another's board.

---

## 3. `RelayEnablement` — replacing hand-held pairing

The row already exists (`tap_pairings`). What changes is its lifecycle.

| Property | Rule |
|---|---|
| Created by | a genuine user gesture on Draft Genie's own page, in an authenticated session (FR-016, FR-018) |
| Held by | the browser. **Never displayed, copied or retained by the user** (FR-017) |
| Scope | one account; that account's own leagues only (FR-019, FR-022) |
| Survives | sign-out and session expiry (FR-020a) |
| Ends by | explicit revocation, or its own stated lifetime (010 FR-014a) |
| Re-acknowledging | idempotent; must not interrupt a relay in progress (FR-020) |

---

## 4. `ObservableState` — the two surfaces

The feature's second-largest source of harm was state that could not be read.

**Tap page** — four states, each with a remedy:

| State | Distinguished by |
|---|---|
| not installed | no script present |
| installed, not enabled | script present, no enablement |
| enabled, idle | enablement present, no recent relay |
| relaying | a **last-relayed time** (FR-009 — evidence, never an assertion) |

**Draft room** — three, and conflating the first two is the bug that fired seven
minutes before a draft:

| State | Meaning |
|---|---|
| waiting for the draft | no session armed for this league |
| cannot reach the service | session exists, transport failed |
| reachable, not receiving | transport fine, no frames arriving |

Plus `unknown`, which must be reported rather than guessed (FR-015).

---

## 5. `LedgerAdmission` — the containment decision

Not stored; a decision made per ledger and **recorded when negative** (FR-025).

| Input | Use |
|---|---|
| ledger coverage | does it account for a whole draft? |
| session's observed incremental picks | has this session ever seen one? |
| tap-reported draft-room completion | authoritative when present (research §2) |

**Rule**: a complete-looking ledger reaching a session that has never observed an
incremental pick is a different draft — rejected and recorded. A session that has
seen picks still accepts its ledger, which is the recovery case (FR-026).

---

## 6. Corpus entry provenance (US7)

One field added to 008's `CorpusEntry`:

| Field | Meaning |
|---|---|
| `relayedByAnotherManager` | true when the frames came from a leaguemate's relay (FR-038) |

Perspective — team, settings, preferred list — still comes from the operator's
own account (FR-037, FR-039). The frames may be anyone's in the league; the
viewpoint may not.
