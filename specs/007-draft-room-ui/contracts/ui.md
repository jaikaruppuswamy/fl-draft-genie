# 007 Contracts

**Feature**: 007 | **Date**: 2026-08-05

007 **exposes no HTTP surface**. It adds no endpoint, no table and no migration.
Its contracts are of two other kinds: the **reducer** that 008 and any future
consumer can drive offline, and the **consumption rules** it owes the features it
reads from.

---

## 1. The reducer contract

```ts
// web/src/lib/draftRoom.ts — pure. No fetch, no Date, no DOM.
export function reduce(state: RoomState, input: RoomInput, at: number): {
  state: RoomState;
  effects: Effect[];
};
```

Shapes are in [data-model.md](../data-model.md). Four properties are
contractual, not implementation detail:

1. **Purity.** `at` is a parameter, never read from a clock. No `fetch`, no
   `Date.now()`, no DOM access. This is what makes FR-024's offline replay
   possible at all, and it is enforced structurally by the same kind of guard
   006 uses on `src/engine/`.
2. **Effects are described, not performed.** The reducer returns *"fetch the
   recommendation"*; the caller performs it. SC-001 is a claim about **when the
   decision to fetch is made**, so the decision has to be inspectable.
3. **Idempotence on replay.** Feeding the same frames in the same order with the
   same timestamps produces the same state, every time.
4. **Duplicates are free.** A frame at or below `cursor` produces no state change
   and no effects — 005's stream is explicit that duplicates are expected, and
   treating one as a gap causes a resync storm exactly when the draft is busiest.

### And one property of the screen as a whole

5. **Read-only (FR-020, Constitution VI).** Nothing under the draft room issues a
   request other than `GET`. This is asserted **structurally**, by reading the
   source — the same way 006 proves it issues zero ESPN requests, and for the
   same reason: "the code happens not to contain a write today" is not a property,
   it is a coincidence waiting to be broken by a convenience helper.

---

## 2. What 007 owes 005

- **Cursor discipline**: discard `seq <= cursor`; resync only on a true *forward*
  gap. Already implemented in `draftSocket.ts`; the reducer must not undo it.
- **Epoch is a reset, not an error**: an epoch change discards local state and
  re-reads the snapshot. Carrying a stale cursor across one would silently skip a
  reconstructed draft.
- **Reachability ≠ picks arriving.** `draftSocket.ts` reports whether *Draft
  Genie* is reachable. Whether *picks* are arriving is 005's `withholding`
  verdict. The screen must never conflate them: the remedies differ — "wait" vs
  "go check the tap's tab" — and during a live draft a wrong diagnosis costs a
  pick.
- **No reconciliation client-side.** Events are applied additively for display.
  Anything requiring judgement (ordinals, ledger merges, pending vs confirmed) is
  re-read from the snapshot.

---

## 3. What 007 owes 006 — and the correction it forces

007 consumes `GET /api/leagues/:id/recommendations` and
`GET /api/leagues/:id/recommendations/players/:playerId` unchanged.

### The obligation, restated

006's `contracts/api.md` §1a currently reads:

> Any consumer … **MUST** issue the request on 005's `on_deck` event, not on
> `on_the_clock`.

**That wording is wrong and must be amended.** It fails twice:

1. **It is impossible at a snake turnaround.** 005's event model states `on_deck`
   fires "as early as the draft's *structure* allows, at most two picks ahead",
   and the owner's second consecutive turn can only ever be one pick away. The
   rule could not be honoured 12 times in a 12-round draft.
2. **It prescribes a mechanism where it meant an outcome.** The intent was *"a
   recommendation is current when the turn begins"*. 007 achieves that by
   refreshing on **every** pick, which is strictly stronger — no single request's
   failure can leave the owner with nothing.

**Corrected obligation** (to replace §1a in 006):

> A consumer MUST ensure a recommendation reflecting the current draft state is
> **already available when the owner's turn begins**. Refreshing on every pick
> satisfies this. Listening for a specific event does not, on its own: at a snake
> turnaround no earlier signal than `on_the_clock` exists.

ROADMAP has been corrected already. **006's contract file has not**, and doing so
is a task in this feature — left alone it governs an implementation that
disagrees with it, and would push a future consumer toward the fragile design.

### Request discipline

- **At most one request in flight.** A pick landing during a request sets a dirty
  flag; exactly one further request fires when the outstanding one returns.
  Bounds cost by round-trip time rather than pick rate — measured autodraft runs
  hit ~1 pick/second.
- **A response is stale if `revision` no longer matches.** Discard it rather than
  render it (FR-016).
- **A withheld response is a 200 with empty entries**, not an error. The screen
  renders the reason and the remedy, and must not retry it as a failure.

---

## 4. Visual state contract (FR-023, SC-010)

Three states, distinguishable **from a screenshot, without reading text**:

| State | Meaning |
|---|---|
| idle | someone else's pick |
| on deck | the owner is next |
| on the clock | the owner's turn |

Built from tokens already in `web/src/styles.css`. No sound, no notifications —
and per FR-023a the screen must not imply it will reach an owner who is looking
elsewhere.

---

## 5. What does not change

- 005's stream, event shapes, cursor rules and `?since=` resume.
- 006's endpoints, response shape, and engine.
- The preferred-list page and its endpoints.
- The ratified design at `/design/draft`, which this feature makes real.
