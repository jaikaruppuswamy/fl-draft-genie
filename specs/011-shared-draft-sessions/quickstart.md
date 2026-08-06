# Quickstart: Shared Draft Sessions

**Feature**: 011-shared-draft-sessions

How to prove each user story works. Everything here is reproducible with two
accounts and one mock draft — which is exactly how the defects were found.

---

## Prerequisites

- `npm ci`
- Two Draft Genie accounts, both connected to the same ESPN league and season
- Desktop Chrome with the userscript, on **one** of them only

---

## 1. The suite

```bash
npm test
```

New coverage to look for:

| Check | Proves |
|---|---|
| A frame for a league arms **every** connected manager's session | FR-001 |
| Each session builds state from its **own** scope | FR-002, FR-005 |
| Nothing in a delivered payload names the relayer | FR-003, SC-003 |
| A non-member receives nothing | FR-004 |
| Duplicate frames from two relays converge on one pick | FR-007a |
| A later frame carrying **more** information is not discarded for arriving second | FR-007b |
| A complete ledger at a session with no picks is rejected **and recorded** | FR-023 – FR-025 |
| A session **with** picks still accepts its ledger | FR-026 — recovery must not break |
| Reset clears state and leaves the session armable | FR-031 |
| Reset preserves preferred list, settings, enablement, frames | FR-028, FR-029 |
| Enablement is not creatable without a user gesture | FR-018, SC-012 |
| Frames remain reachable across a reconnect | FR-036, SC-010 |

**The one that matters most is the ledger pair.** Rejecting contamination is
easy; rejecting it *without breaking recovery* is the whole difficulty, because
ledgers exist precisely to restore a draft after a reload.

---

## 2. US1 — see a leaguemate's draft

With the tap running on account A only:

1. Open a draft room on A. Confirm frames relay.
2. On **B** — no userscript, any device — open the draft room for the same
   league.
3. **Expect**: picks arrive live, with **B's** team highlighted, B's roster and
   B's preferred list.

Then close A's laptop mid-draft.

4. **Expect**: B is told the feed has stopped and what would restore it —
   the same message A would see (FR-006a), never "waiting for the draft".

---

## 3. US2 — honest state

Put each surface into each state and read it:

| Surface | Force it by |
|---|---|
| tap: not installed | a browser without the script |
| tap: installed, not enabled | install, do not acknowledge |
| tap: enabled, idle | acknowledge, open no draft room |
| tap: relaying | open a draft room — expect a **last-relayed time** |
| room: waiting | open a league whose session has never armed |
| room: cannot reach | block the transport |
| room: not receiving | reachable, no frames |

**Expect**: each named distinctly, each with a remedy. The pre-draft case must
say *waiting*, not *cannot reach* — that false alarm fired seven minutes before a
draft on 2026-08-05.

---

## 4. US3 / US6 — one-step setup

From a browser with nothing installed:

```
install the userscript → open the tap page signed in → acknowledge
```

**Expect**: zero values typed or pasted, zero credentials displayed, and the tap
relaying from the next draft room you open. Then re-acknowledge and confirm
nothing breaks.

Sign out. **Expect**: the tap keeps relaying (FR-020a), and the tap page still
offers to stop it.

---

## 5. US4 — no finished draft in a fresh one

1. Leave a tab open on a **completed** draft.
2. Arm a fresh session for the same league.
3. **Expect**: none of the finished draft's picks appear, and the rejection is
   recorded with a reason.
4. Now reload a draft **in progress** and confirm its own ledger still restores
   it.

---

## 6. US5 — reset

```
reset the session → run a second mock
```

**Expect**: the new draft is captured with none of the first's picks, and the
preferred list, league settings and tap enablement are all intact. Confirm the
retained frames from the first draft still exist.

Then try resetting **during** a live draft: it must refuse or demand explicit
confirmation (FR-030).

---

## 7. US7 — capture history

```bash
npx tsx scripts/lab-admit.ts --league <id> --season 2026 --class test --as <you>
```

**Expect**: frames captured before a reconnect are still listed. Frames relayed
by a leaguemate are usable, and the entry records that (FR-038) — while its team,
settings and preferred list still come from your own account (FR-039).

---

## Troubleshooting

| Symptom | Meaning |
|---|---|
| B sees nothing while A relays | Fan-out did not arm B's session. Arming is league-wide now, not per-tap. |
| B sees A's team highlighted | Perspective bleed — the exact failure this feature exists to prevent. |
| A finished draft's picks appear | Ledger admission accepted a complete ledger at an empty session. |
| A reload no longer restores a draft | The containment rule is too strict — it must only reject at sessions with **no** observed picks. |
| Re-acknowledging kills a live relay | Enablement is not idempotent (FR-020). |
