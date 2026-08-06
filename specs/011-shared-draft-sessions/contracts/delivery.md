# Contract: League-Shared Delivery

**Feature**: 011-shared-draft-sessions

Who may send, who may receive, and what each side is promised. The two rules the
feature turns on, expressed as obligations.

---

## Sending

| Obligation | |
|---|---|
| **Attribution required** | Every relayed frame is attributed to exactly one account, by credential. Rejected otherwise (FR-022). |
| **Never inferred** | Attribution is never derived from an armed session, a live-draft window, or a league identifier alone (FR-022a). Those are weakest exactly when a draft is live. |
| **Scope** | An account may relay only for leagues **it** has connected. Unchanged from 010. |
| **Several relays welcome** | Two managers relaying one draft is resilience, not conflict (FR-007a). |
| **Passive** | No connection opened to ESPN, no message sent to it, no send path (FR-041). |
| **Numeric only** | No names, member identifiers or free text (FR-043). |

## Receiving

| Obligation | |
|---|---|
| **Audience** | Every manager who has connected that league and season — no more, no fewer (FR-001, FR-004). |
| **No ceremony** | No setting, consent step or coordination on either side (FR-003a). |
| **Own perspective** | Each manager's view uses their team, settings, roster needs and preferred list (FR-002). |
| **Relayer anonymous** | Nothing discloses who relayed (FR-003). |
| **Latency** | 005's ratified budget, unchanged: p95 ≤ 2 s, 100% ≤ 10 s (FR-007). |

## Convergence

- Duplicates describing one pick converge on one pick (FR-007a).
- A frame carrying **more information** wins over one that merely arrived first
  (FR-007b). This mirrors `foldBatches`, which already prefers ledger coverage
  over arrival order — a tap flushing after an outage sends an old snapshot with
  a new timestamp.

## Ledger admission

A ledger becomes a session's baseline only if the session has already observed an
incremental pick, **or** the ledger does not account for a whole draft.
Otherwise it describes a different draft: rejected, and the rejection recorded
(FR-023 – FR-025).

A session that has seen picks still accepts its own ledger — recovery is what
ledgers exist for, and this must not break it (FR-026).

## Reporting

Delivery states are named, never merged:

| State | Never confused with |
|---|---|
| waiting for the draft | cannot reach the service |
| cannot reach the service | reachable but not receiving |
| relay stopped mid-draft | a draft that has not started (FR-006a) |

Each states its remedy (FR-013). A stopped relay gets **one message for
everyone**, naming what would restore it — actionable by a manager who cannot
relay, because they can ask one who can.
