# Quickstart: Deployment Ops

**Feature**: 009-deployment-ops | **Phase 1**

How to prove each story. The theme throughout: **a monitoring feature is only
proven by making something fail.** Every scenario below causes a real failure and
checks that it is noticed — asserting that a healthy system stays quiet proves
nothing, and is exactly how the archive wrote zero rows for a month while looking
fine.

Prerequisites: `npm ci`; local D1 migrated (`npm run migrate:local`).

---

## US2 — Stop me shipping something broken *(do this first)*

Phase 0 prerequisites, before the gate is turned on:

```bash
npm test
```

Then verify the sweep no longer leaks. Plant a fabricated-but-not-allowlisted
GUID in a fixture, run the sweep, and confirm the output names the **file and a
count** — never any part of the value:

```bash
npx tsx scripts/privacy-sweep.ts
```

Expected: non-zero exit, and the message carries no hex from the planted value.
Remove the plant afterwards.

Verify the fresh-clone case a human would hit:

```bash
git archive HEAD | tar -x -C "$(mktemp -d)"
```

…then `npm ci && npm test` in that directory. It must pass without a prior
`npm run build`.

**Then the gate itself**: open a PR that breaks one test, and a second that adds
an unallowlisted GUID to a fixture. Both must be blocked on the PR before merge,
with the result attributable to the commit.

---

## US1 — Tell me when something has quietly stopped working 🎯

### 1. A stage fails repeatedly, and only then notifies

Force a stage to throw (an unreachable projections source is the easiest). Run
the cron twice.

- After the **first** tick: `ops_conditions` shows `consecutive = 1`, **no alert
  sent**. FR-002.
- After the **second**: an alert arrives naming the stage and a remedy.
- Let the stage recover: `resolved_at` is set and `consecutive` returns to 0.

### 2. The alert says nothing it must not

Inspect the sent body against [contracts/alerts.md](./contracts/alerts.md) §2.
The contract test does this adversarially, but read one real message: no UUID, no
`@`, no URL, no manager name, no league name — an ESPN league id and a season
only.

### 3. Silence is reported — the case that started this feature

Set a league's draft date in the past with no `draft_archives` row for it.
Expected: an alert. **This is the disagreement check, not an
awaiting-archive-age check** — research §6.3 found the obvious predicate blind to
a draft with `totalPicks = 0`, which is every production draft to date.

### 4. The relay lapses during a live draft

Arm a session, heartbeat once, then stop. Expected: an alert distinguishing *the
tap stopped* from *the server stopped*.

**Then the case the heartbeat cannot see, and this is the important one.** Keep
the tap heartbeating and relaying batches, but stop the session consuming them —
`MAX(tap_batches.received_at)` advances while `snapshot().revision` does not.
Expected: a *server-side* alert.

> A heartbeat-only design stays **silent** here, because `recordRelayActivity`
> refreshes the heartbeat on every accepted batch. This is the 2026-08-06/07
> failure — healthy tap, frozen room — and it is the single most important
> scenario in this file. If only one thing is tested, test this.

### 5. Repetition is bounded

Leave a condition failing across many ticks. `notify_count` stops climbing;
messages stop arriving. FR-006.

---

## US3 — Tell me what to do, on the day

Hand `docs/runbook.md` to someone who has not read the source. They must
diagnose, from symptoms alone:

1. no recommendations appearing — and which of the causes it is;
2. the tap not delivering versus a browser problem — including that **the
   draft-room tab *is* the tap**.

Check the limitations section states them **scoped correctly** (FR-016/FR-016a):

- **relaying** needs a desktop browser with a userscript manager;
- **watching** is an ordinary web page and works anywhere, including an iPad.

> The spec previously asked for "no live monitoring from an iPad" as a documented
> limitation. It is not one — the 2026-08-06/07 freeze was a cross-platform
> defect, since fixed. A runbook asserting it would send the owner away from a
> device that works.

Confirm the **break-glass** is written down and can be followed under pressure,
and that the database is referred to **by name only** — then prove it:

```bash
npx tsx scripts/privacy-sweep.ts
```

---

## US4 — Let me get the data back

The drill. **Production is only ever read; it is never written and never
restored.** Run outside any pre-draft window — an export blocks other database
requests.

```bash
npx wrangler d1 export draft-genie --remote --output=/tmp/drill.sql \
  --table pro_teams --table players --table projection_sets \
  --table player_projections --table signal_entries
```

Those five tables are foreign-key closed and carry **no account ids, no league
ids and no league names** — which matters on a public repo with more than one
user. Write outside the repo; delete afterwards.

```bash
npx wrangler d1 create draft-genie-drill
```

Load the export into the drill database, take a `time-travel info` bookmark,
delete rows **in the drill database only**, restore to the bookmark, and confirm
`player_projections` is back. Record the date. Then:

```bash
npx wrangler d1 delete draft-genie-drill
```

Record in the runbook:

- **The window as two bounds** — earliest restorable point is
  `max(database creation, now − retention)`. Retention is 30 days on Workers Paid
  and 7 on Free; **which applies here is unverified** and must be established.
- An out-of-window request returns a bare `internal error [code: 7500]`, not a
  clear rejection.
- **`rebuild()` is mandatory after any restore**, alongside `migrations apply`:
  the Durable Object cursor is not restored with D1, and a surviving cursor makes
  a restored tap log invisible.
- **After a `CREDENTIAL_KEY` rotation, restoring to before it strands every
  credential** under a key that no longer exists — purge and re-paste. This is
  recorded here as well as in the rotation procedure, because the person
  restoring months later will not be reading that one.

### FR-021

Confirm `pruneSets()` no longer deletes prior seasons, that 002's FR-018 carries
a dated superseding note (its **clarification log is left intact** — rewriting
the answer would falsify what was decided), and that the decision is in
ROADMAP.md. Confirm the `database_size` check exists, since removing the prune
removes the only bound.
