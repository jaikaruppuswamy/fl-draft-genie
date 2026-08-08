# Contract: Alerts

**Feature**: 009-deployment-ops | **Phase 1**

An alert is the product's only outbound operational message. This contract says
what may be sent, what may **never** be sent, and when.

---

## 1. What may be said

An alert body is rendered from a **closed vocabulary**. Nothing is interpolated
from an ESPN payload, a user-authored field, or an exception message.

| Permitted | Example |
|---|---|
| Condition kind | `stage_failing`, `draft_relay_lapsed`, `picks_stalled`, `projections_stale`, `archive_missing`, `database_size` |
| ESPN league id + season | numeric, as ESPN issues them |
| Counts and durations | `3 consecutive`, `47 minutes` |
| ISO-8601 timestamps | `2026-08-07T02:30:13Z` |
| A bounded error code | `espn_401`, `fetch_timeout` — from a declared union |
| Fixed remedy text | authored in this repo, one per condition kind |

**Every alert states a remedy.** FR-015 asks for failures distinguished *by
remedy, not by cause* — the owner needs to know what to do. A bare condition name
is a spec violation, by the same argument Principle VII makes about
recommendations.

## 2. What may never be said

> **The operator exemption (constitution 1.2.0, ratified 2026-08-08).** An alert
> may name **any** league by `espn_league_id`, including one belonging to another
> user. It discloses nothing the operator cannot already read directly, and the
> alternative — scoping alerts to the operator's own leagues — would leave
> another user's failing sync unreported indefinitely. **The exemption covers the
> league identifier and nothing else.** Everything in the table below stays
> forbidden.

| Forbidden | Why |
|---|---|
| `espn_s2`, `SWID`, any credential | Constitution — and it is why the outbound screen exists |
| A member GUID, in any format | same |
| A manager or member name | shipped to a public repo once already |
| `connection_id`, `account_id`, any UUID | a UUID maps 1:1 to an account and league; under 011's fan-out it may be **another account's**. Naming one names a person indirectly |
| `league_snapshots.league_name` | ESPN-side, user-authored, can carry a person's name. `espn_league_id` conveys the same scope with none of the risk |
| An email address | including the recipient's own |
| Any URL | matches the tap-ingest posture — a draft-room URL carries a SWID as a query parameter |
| A raw exception message | unbounded text from ESPN or the runtime |

## 3. The outbound screen

**Asserted immediately before send, over both subject and body**, and applied
regardless of how the message was built:

- no `[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-…` GUID shape
- no `https?://`
- no `@`

This duplicates guarantees the renderer already makes. That is the point: the
renderer is a design, the screen is a control. `src/api/tap.ts` already takes
this posture on the inbound side — *"a privacy control asserted only at the
source is asserted once, by the party most likely to be out of date."*

Failing the screen **drops the alert and logs the condition key only**. An alert
is never sent partially redacted — a redaction bug must not become a delivery
path.

## 4. When an alert is sent

| Rule | Requirement |
|---|---|
| Two observations before notifying | FR-002 — one raises a suspicion, a second confirms; any healthy observation clears it |
| **Exception**: the live-draft checks | their thresholds are already the debounce (150 s lapse = three missed beats; 5 min of no picks ≈ three missed pick slots). Doubling them doubles detection time on the draft-day path |
| Live-draft checks run every **1 minute** | FR-003c — on the 5-minute grid, SC-002's five-minute promise is arithmetically unreachable (150 s + 300 s = 7.5 min). The check short-circuits when no draft is armed |
| Picks-stalled threshold is **5 minutes** | FR-003a/b — clear of the 90 s+ human pick cadence 005 measured. **This is the predicate that catches a frozen room; the heartbeat cannot, because it refreshes on every accepted batch** |
| Bounded repetition | FR-006 — `notify_count` capped, with backoff, until `resolved_at` |
| Recurrence may notify again | a cleared-then-returning condition is news |
| Scope in the subject | FR-008 — which league, when a league is implicated |
| Never per-session fan-out | one condition produces **one** alert, keyed by league — not one per entitled manager |

## 5. Delivery

- Channel: the existing Cloudflare `EMAIL` send_email binding.
- Destination: the **`ALERT_TO` secret**. Never a `destination_address` in
  `wrangler.jsonc` — that file is committed to a public repo and would publish
  the operator's address.
- The alert module is **separate from `EmailSender`**. The sign-in contract stays
  untouched; the channel is reused through the existing provider factory.
- Missing `ALERT_TO` or `EMAIL` **throws loudly**, matching `cloudflareSender`.
  A silent no-op alerter is the failure mode this whole feature exists to end.

## 6. Known gaps, stated rather than hidden

**If the cron stops entirely, no alert can fire** — the detector and the notifier
both run on the dead cron. Closing this needs an external heartbeat, which is
more machinery than one operator warrants. The runbook names Cron Trigger Past
Events as the manual check.

**The alert channel shares fate with sign-in email.** If the provider is down,
the alert about it cannot arrive. Recorded as an edge case in the spec, not
engineered away.
