# Phase 0 Research: Shared Draft Sessions

**Feature**: 011-shared-draft-sessions | **Date**: 2026-08-06

Every finding below was checked against the shipped code. Two of them change the
shape of the work.

---

## §1 — How to make delivery league-wide: fan out, do not re-key

The session is `DRAFT_SESSION.idFromName(`${connectionId}:${season}`)`, and
`SessionScope` mixes shared facts (`espnLeagueId`, `season`, `order`,
`totalPicks`) with per-manager ones (`accountId`, `connectionId`, `myTeamId`).

Two ways to serve a whole league:

| | Re-key to `leagueId:season` | **Fan out to each connection's session** |
|---|---|---|
| Sessions per league | one | one per connected manager |
| Perspective | must be lifted out of the DO and applied per viewer | already per-session, unchanged |
| Migration | every live session re-addressed | none |
| Reconcile work | once | once per manager (6–12) |
| Blast radius of a bug | every manager in the league | one manager |

**Decision: fan out.** On ingest, arm and nudge **every** armed session for that
`(espnLeagueId, season)` rather than only the relayer's. Each Durable Object
reconciles the same frames against its own scope, so FR-002 (own perspective) and
FR-005 (own settings) are satisfied *by construction* rather than by new code.

**Rationale**: the re-key is a strictly larger change that also has to invent a
per-viewer perspective layer the fan-out gets for free. Duplicated reconcile work
at 6–12 managers is nothing against a draft's pick rate, and 005's latency budget
(p95 ≤ 2 s, measured 0.223 s) has three orders of magnitude of headroom.

**Consequence to design for**: sessions currently arm lazily *from their own
tap's first frame*. A manager with no tap has no session and therefore nothing to
deliver to. Arming must become league-wide too — any frame for a league arms
every connected manager's session, each with its own scope.

**Alternatives considered**: *deliver from the relayer's session to other
managers' sockets.* Rejected — one manager's session state would drive another's
board, which is exactly the perspective bleed that caused the T031 incident.

---

## §2 — What binds a ledger to its draft (the deferred question, now answerable)

**A ledger frame carries nothing that identifies its draft.** `PickPayload` is
`{teamId, playerId, slot3, overallPickNumber}` — no draft id, no start time. The
wrapper adds `observedAt` (when the tap saw it) and `epoch` (the tap's clock
anchor), neither of which distinguishes last week's draft from tonight's.

Nor does the tap session help: in the observed incident one tap session
(`ba272c79`) emitted ledgers at 04:17, 04:20 **and** 04:27, spanning a league
reconnect. Same session, two different drafts.

So the binding must be **behavioural**, and there is a usable signature:

> **A finished draft cannot be the first thing a session learns.**
>
> A live draft's ledger arrives early and is partial or empty, then the
> incremental stream fills it in — 010 measured 69 of 72 picks arriving
> incrementally, 3 only via ledger. A *completed* draft's ledger is complete on
> arrival. So a ledger that accounts for a whole draft, reaching a session that
> has never observed an incremental pick, is describing a different draft.

**Decision**: reject a complete-looking ledger at a session with no observed
incremental picks; record the rejection (FR-025). Accept ledgers at sessions that
have seen picks — which is the recovery case FR-026 protects, and is unaffected.

**Second signal, weaker but cheap**: `tap/draftEnd.ts` already detects draft end
on the tap side. Having the tap state that the room it is attached to shows a
*completed* draft would make the rejection direct rather than inferred. Worth
adding; not worth depending on alone, since it is a tap change and taps update
on their own schedule.

**Rejected**: binding on `scheduled_at`. Mock drafts have none, and the observed
contamination was a mock — the signal is absent exactly where it is needed.

**Residual risk, stated**: a genuine draft that is resumed from scratch after
completing — a session with no picks legitimately receiving a complete ledger —
would be rejected. That is a draft that has already finished; refusing to
re-ingest it costs nothing, and the rejection is recorded rather than silent.

---

## §3 — Handing the credential over without the user touching it

The userscript runs at `document_start` on ESPN's draft-room page. Nothing stops
it also matching Draft Genie's own origin. When a signed-in owner opens the tap
page and acknowledges, the page can hand the browser what it needs directly.

**Decision**: the acknowledgement is a real user gesture on Draft Genie's own
page, in a session that is already authenticated. No cross-origin credential
flow, no CSRF surface added, nothing displayed.

**Rationale**: the two hard parts are already solved elsewhere — the user is
authenticated by the ordinary app session, and the script is already a
same-browser artifact. The only new thing is the handshake.

**Alternatives considered**:
- *Cross-origin request with credentials from ESPN's page.* Rejected: it makes
  any page able to attempt enablement, and FR-018 requires a genuine gesture.
- *Device-code style approval.* Rejected: it is the pairing flow with extra
  steps.

**Constraint carried from clarify**: enablement survives sign-out (FR-020a), so
it cannot be a session cookie. It remains a stored credential with a lifetime —
the change is who handles it, never whether it exists (FR-022, FR-022a).

---

## §4 — Duplicate relays

`foldBatches` already unions ledger and incremental picks, and `reconcile` merges
on pick identity — 010's corpus contained the same pick from both sources and it
resolved to one. Two relays are the same problem with a wider source set.

**Decision**: accept every relay, converge on pick identity, and prefer the frame
that carries more information rather than the one that arrived first.

**Rationale for the second half (FR-007b)**: `foldBatches` already keeps the
ledger with the greatest *coverage* rather than the latest arrival, for exactly
this reason — a tap flushing after an outage sends an old snapshot with a new
`received_at`. First-writer-wins would discard a correction, which is a bug that
looks like working deduplication until the night it matters.

---

## §5 — Resetting a session

`DraftSession` has `shutdown()` — `deleteAlarm()` + `deleteAll()` + `closed:
true` — and `arm()` returns early on `closed`. So the only clearing method is
permanent, which is why the workaround was disconnect-and-reconnect, destroying a
preferred player.

**Decision**: a `reset()` that clears state and the alarm but **not** the closed
flag, leaving the object armable again (FR-031). Reached by an owner action in
the app, refused or confirmed during a live draft (FR-030).

**Rationale**: the DO id is derived from `connectionId:season`, so a reset cannot
mint a new object without a new connection — which is the very cost being
removed. Clearing in place is the only route that preserves the connection, and
with it the preferred list, settings and tap enablement (FR-028).

**Note**: under §1's fan-out, reset is per manager. Resetting one manager's
session does not disturb a leaguemate's.

---

## §6 — Frame reachability for the lab

`tap_batches` carries **both** `account_id` and `connection_id`. 008's
`lab-admit.ts` filters on `connection_id IN (my connections)`, so a reconnect
orphans history.

**Decision**: filter on `account_id`. It is the actual FR-027 boundary, it
survives reconnects, and it is already on the row — no schema change.

**Consequence**: a leaguemate's frames become usable (FR-037), while perspective
still comes from the operator's own connection. That is the narrower, correct
version of the over-correction shipped in T031.

---

## Resolved unknowns

| Unknown | Resolution |
|---|---|
| League-wide delivery without re-keying | §1 — fan out on ingest; arming becomes league-wide |
| What binds a ledger to its draft | §2 — a finished draft cannot be a session's first knowledge |
| Credential handoff with no user handling | §3 — gesture on Draft Genie's own page, already authenticated |
| Duplicate relays | §4 — converge on pick identity; prefer more information over earlier arrival |
| Resetting without a new connection | §5 — clear in place, without the closed flag |
| Frames unreachable after reconnect | §6 — scope by account, not connection |

**One item stays deferred to implementation**, deliberately: the account
ambiguity edge case (signed in as one account, drafting a league connected under
another). Under §1 the answer falls out — frames are attributed to the relaying
account and delivered by league — but the *enablement* case wants a decision only
once someone actually has two accounts.
