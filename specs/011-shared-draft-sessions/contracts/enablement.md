# Contract: Relay Enablement

**Feature**: 011-shared-draft-sessions

What the owner does, what the system promises, and what neither may do.

---

## The whole flow

1. Install the userscript. *(Desktop Chrome — 010's permanent limitation, stated
   on the page, FR-035.)*
2. Open the Draft Tap page **while signed in**.
3. Acknowledge once.

That is all of it. There is no fourth step, and step 3 is a real user gesture,
not something a page can cause (FR-018).

## Promises

| | |
|---|---|
| **Nothing to handle** | No credential, code or identifier is shown to, copied by, or retained by the user (FR-017). |
| **Idempotent** | Acknowledging again is safe and does not interrupt a relay in progress (FR-020). |
| **Survives sign-out** | Enablement belongs to the browser, not the session (FR-020a). A draft outlasts a session, and under shared delivery a relay dying mid-draft takes a league's feed with it. |
| **Revocable** | From the tap page, per browser, with the effect stated — including that ESPN is unaffected (FR-033, FR-034). |
| **Expires** | It retains a stated lifetime (010 FR-014a), renewed silently while signed in. |
| **Fails safely** | A failed enablement states why and leaves any working state intact (FR-021). |

## Prohibitions

- **Not** triggerable by a page the owner merely visits (FR-018, SC-012).
- **Not** created without an authenticated session (FR-019).
- **Not** a substitute for attribution — the credential's *handling* changes, its
  *existence* does not (FR-022).

## The page afterwards

Covers installing, enabling, and current state. It **no longer instructs anyone
to pair a browser or handle a credential** (FR-032) — the step that produced
three pairings in fourteen minutes on draft night, each revoking a working one,
because nobody could tell from outside whether pairing was the problem.
