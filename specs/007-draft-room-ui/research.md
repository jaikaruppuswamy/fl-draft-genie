# Phase 0 Research: Draft Room UI

**Feature**: 007 | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md)

Clarification settled *what* the screen does. This phase settles *where the
logic lives* — and one decision dominates all the others.

FR-024 requires SC-001 ("a recommendation on screen before the turn begins") be
verified **offline**, at the archived draft's real timing. The obvious reading is
"render React in a headless DOM and measure". That would mean a jsdom runtime, a
component-testing library, and a fourth vitest project — a new dependency stack
whose only job is to make a timing claim checkable.

There is a much better answer, and this project has used it twice already.

---

## §1 — The screen's brain is a pure state machine, not a component

**Decision**: all draft-room logic lives in `web/src/lib/draftRoom.ts` as a
**pure reducer over frames and time**:

```text
reduce(state, input) → { state, effects }

input   = a stream frame, a fetch result, or a clock tick
effects = "fetch the recommendation", "fetch the snapshot" — described, not performed
```

React renders `state`. It decides nothing.

**Rationale**: this is exactly what 005 did with `reconcile.ts` and 006 with
`recommend.ts`, and for the same reason — it makes the properties that matter
**testable without the platform they run on**. SC-001 becomes a question about a
function, answered by feeding it the real corpus at real timestamps and reading
off when the recommendation became current. No DOM, no new dependencies, no
fourth vitest project. The existing `node` project runs it.

It also means the timing claim is checked against the thing that actually decides
the timing. A DOM test would measure React's render, which is not where SC-001
can fail — the failure mode is *deciding to fetch too late*, which is pure logic.

**Effects are described, not performed.** The reducer returns "you should fetch
the recommendation now"; the React layer performs it. That keeps the reducer pure
(no `fetch`, no clock reads) and makes the *decision to fetch* — the only thing
SC-001 is about — directly assertable.

**Alternatives considered**:

- *jsdom + a component testing library.* Rejected: two new dependencies and a new
  test project, to test a layer where the property cannot fail. Constitution VIII
  is explicit about preferring the simplest design that satisfies the spec.
- *Logic inside the React component, tested through the rendered output.*
  Rejected for the same reason 005 kept the reducer out of the Durable Object:
  the moment the logic needs a host to run, every test needs that host too, and
  the offline replay FR-024 asks for becomes impractical.

---

## §2 — How picks reach the screen: apply events, verify by snapshot

**Decision**: a `pick_made` event is applied **additively** to the displayed
board (it carries `overall`, `teamId` and `playerId` — enough to place a cell).
The full snapshot is re-read only on:

- a **revision bump** (a correction — 005 replays affected turns),
- an **epoch change** (a rebuild),
- a **forward gap** or reconnect, and
- the **first load**.

**Rationale**: 005's diagnostic page re-reads the entire snapshot on every event,
because it deliberately has no reducer — it was a throwaway. Carrying that
forward would cost a round trip per pick purely to learn something the event
already told us.

But the important half is what this design **refuses** to do: it does not
reimplement 005's reducer in the browser. Appending a pick to a grid is not
reconciliation — there is no ordinal derivation, no ledger merge, no pending/
confirmed distinction. All of that stays server-side, where it was fought for.
The moment the client would need to *reason* about a pick rather than display it,
it asks the server instead.

That boundary is the rule: **the client displays; the server decides.**

---

## §3 — Refreshing on every pick, without a request per pick

FR-003 says refresh the recommendation on every pick. Taken literally that is one
request per pick — and measured autodraft runs produced **~1 pick per second**,
so a literal reading means ~60 requests a minute.

**Decision**: **one request in flight at a time, with a trailing refresh.** If
picks land while a request is outstanding, exactly one more fires when it
returns — no queue, no per-pick fan-out.

```text
pick lands → request in flight?  no  → fetch now
                                 yes → mark dirty; fetch once on completion
```

**Rationale**: this keeps FR-003's guarantee (the recommendation is never more
than one round trip behind the board) while bounding requests by *round-trip
time* rather than by pick rate. Under an autodraft burst it collapses a dozen
picks into two requests; during human picks, where gaps run 90 s+, it is
indistinguishable from fetching per pick.

It also degrades in the right direction: if the server is slow, the screen makes
*fewer* requests, not more. A per-pick queue would do the opposite at exactly the
wrong moment.

**Alternatives considered**:

- *Fixed debounce (e.g. 500 ms).* A timer to tune, and it either adds latency to
  the quiet case or fails to coalesce the busy one. The in-flight check needs no
  constant.
- *Fetch only near the owner's turn.* Rejected in clarification: it makes a
  single request load-bearing, which is the fragility FR-003a exists to remove.

---

## §4 — Measuring SC-001 offline

**Decision**: the replay harness drives the §1 reducer with
`tests/fixtures/tap/replay-full.jsonl` — 72 real frames, each carrying a true
`observedAt` — advancing a **virtual clock** to each frame's timestamp.

For every turn belonging to the owner it records:

```text
readyAt   = when the reducer last marked a recommendation current
turnAt    = when that turn began
SC-001 passes for the turn if readyAt <= turnAt
```

`readyAt` accounts for the modelled round trip, so the measurement is not
trivially true. The harness reports the fraction of turns satisfied and asserts
it meets 95%, and separately asserts the snake-turnaround turns (SC-009).

**Rationale**: a virtual clock is what makes this a *test* rather than an hour
of waiting. It is also strictly more honest than a live measurement taken once:
every turn in the corpus is checked, including the ones a live run happens not to
stress.

**The harness must prove it ran.** It asserts a minimum count of turns evaluated,
for the reason 005 learned the hard way: an SC-010 test there passed while
walking a corpus that could not express the failure it was written for.

---

## §5 — Two routes to "complete", and what to do when they disagree

**Decision**: the screen concludes the draft is over when **either**

- 005 delivers `draft_complete`, **or**
- the observed pick count reaches the draft's stated total.

and it records **which route fired first**, surfacing a disagreement rather than
resolving it.

**Rationale**: neither route has evidence behind it. The completion event has
**never fired in production** — `draft_archives` holds zero rows, because the
draft length was `0` during the only live test, making completion unreachable.
And the pick count depends on that same draft length, which has been wrong
before. Two untested routes are not twice the confidence, but they fail
*differently*: a missing event and a wrong total do not coincide.

Surfacing the divergence is the point. Whichever fires alone on the next real
draft is the first evidence anyone will have about which to trust, and silently
resolving it would throw that evidence away.

**Alternatives considered**:

- *Wait for the event only.* Rejected: on the evidence available it may never
  arrive, and the screen would sit live forever after the last pick.
- *Pick count only.* Rejected: a too-low total declares completion early, which
  is the more damaging error — it would stop recommending mid-draft.

---

## §6 — Reasoning: what fits in 318px

**Decision**: the rail shows, per recommended player, the value and **the single
adjustment with the largest absolute magnitude**, phrased as 006 already phrases
it ("top-5 offense", "unlikely to last your next 12 picks"). The full explanation
opens in a panel modelled on the existing `PlayerDetailSheet`.

**Rationale**: 006 already emits every adjustment with a signed magnitude and a
named reason, so "the biggest one" is a `reduce`, not a judgement. Picking by
magnitude means the headline is always the reason that actually moved the player
most — which is the one an owner would ask about first.

The panel is not new UI vocabulary: `PlayerDetailSheet.tsx` exists and does
exactly this shape for projections. Reusing it keeps one interaction pattern
rather than two.

**Where 006's `forcedBy` goes**: when a pick is forced (FR-025 in 006), that
replaces the headline entirely — "forced: K still unfilled, 1 pick left" is more
important than any adjustment, and it is the one case where the engine is not
choosing.

---

## §7 — On deck and on the clock, visually

**Decision**: three states, distinguishable without reading text (SC-010):

| State | Treatment |
|---|---|
| Ordinary | The design's resting appearance |
| On deck | The owner's column and the rail take an accent border |
| On the clock | Accent fill on the rail header, and the owner's cell in the grid |

All three use tokens already in `web/src/styles.css` from the ratified system.
No new colours, no animation that would draw the eye during someone else's pick.

**Rationale**: SC-010 is verifiable from a screenshot, which forces the states to
differ in *treatment* rather than in wording. Reusing the existing accent ramp
keeps this inside the ratified design rather than extending it.

**And nothing more.** Clarification settled visual-only — no sound, no
notifications. FR-023a is explicit that the alert reaches the owner only while
they are looking, and the screen must not imply otherwise.

---

## §8 — What this feature does not build

Worth stating, because each was a plausible thing to add and each belongs
elsewhere:

- **No client-side reconciler.** 005 owns pick reconciliation (§2).
- **No new recommendation logic.** 006 owns the engine; the screen renders it.
- **No preferred-list editing.** 006 ships that page; this screen links to it.
- **No new socket client.** `draftSocket.ts` already handles backoff, cursor
  discipline, epoch reset and the polling fallback after three failures.
- **No DOM test stack.** §1 removes the need for it.
- **No new server endpoints.** Everything the screen needs is deployed.

---

## Resolved unknowns

| Unknown | Resolution |
|---|---|
| Where the screen's logic lives | §1 — a pure reducer in `draftRoom.ts`; React renders, decides nothing |
| How SC-001 is measured offline | §4 — virtual clock over the real 72-frame corpus, no DOM |
| How picks reach the display | §2 — apply events additively; re-read the snapshot only on revision, epoch, gap or first load |
| Request cost of refresh-per-pick | §3 — one in flight, one trailing; bounded by round trip, not pick rate |
| Completion when the signal never fires | §5 — either route concludes; divergence surfaced |
| Reasoning in a 318px rail | §6 — largest-magnitude adjustment as headline; full breakdown in a panel |
| Making on-deck/on-clock visible | §7 — three token-based treatments, screenshot-verifiable |
| New dependencies required | **None.** §1 is what makes that true. |

No NEEDS CLARIFICATION remains.
