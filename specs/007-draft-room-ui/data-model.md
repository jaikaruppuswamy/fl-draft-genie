# Phase 1 Data Model: Draft Room UI

**Feature**: 007 | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**Nothing here is persisted.** 007 adds no table, no column and no migration.
Everything below is in-memory state in the browser, derived from 005's stream and
006's board — which is why the whole model can be a pure reducer (research §1).

---

## The reducer

```text
reduce(state: RoomState, input: RoomInput, at: number) → { state: RoomState, effects: Effect[] }
```

`at` is passed **in**, never read. That is what lets the replay harness advance a
virtual clock across a 72-pick draft in milliseconds (FR-024), and it is the same
discipline that keeps 005's reducer and 006's engine testable offline.

### `RoomInput`

| Variant | Carries | Source |
|---|---|---|
| `frame` | a `DraftFrame` — snapshot, event or status | 005's stream |
| `recommendation` | a ranked board, or a failure | 006's endpoint |
| `snapshot` | a full draft snapshot | 005's REST snapshot |
| `reachability` | `connected` / `reconnecting` / `polling` | `draftSocket.ts` |
| `tick` | nothing | the countdown before the draft |

### `Effect`

Described, never performed — the reducer stays pure and the *decision* becomes
directly assertable.

| Effect | When |
|---|---|
| `fetchRecommendation` | a pick landed and no request is in flight (research §3) |
| `fetchSnapshot` | revision bump, epoch change, forward gap, or first load |

---

## `RoomState`

| Field | Shape | Notes |
|---|---|---|
| `phase` | `"pre_draft" \| "live" \| "complete"` | drives which layout renders |
| `picks` | `Pick[]` | every pick placed, ordered by overall |
| `revision` | `number` | 005's; a bump invalidates the recommendation |
| `epoch` | `string \| null` | a change means rebuild — discard and re-read |
| `cursor` | `number` | last applied `seq`; duplicates below it are dropped |
| `onTheClock` | `teamId \| null` | |
| `picksUntilMyTurn` | `number \| null` | **null is "unknown"**, never zero |
| `myTurnState` | `"idle" \| "on_deck" \| "on_the_clock"` | drives FR-023's visual state |
| `recommendation` | `RankedBoard \| null` | 006's response, verbatim |
| `recommendationRevision` | `number \| null` | which revision it was computed for |
| `inFlight` | `boolean` | one request at a time (research §3) |
| `dirty` | `boolean` | a pick landed while in flight; fetch once on return |
| `reachability` | `"connected" \| "reconnecting" \| "polling"` | Draft Genie, **not** the tap |
| `withholding` | `{ reason, detail } \| null` | 005's verdict, surfaced verbatim |
| `completion` | `Completion \| null` | see below |
| `draftAt` | `string \| null` | scheduled start, for the countdown |
| `order` | `number[] \| null` | **null means ESPN has not published it** |

### `Completion` — two routes, and their disagreement

| Field | Shape | Notes |
|---|---|---|
| `by` | `"signal" \| "pick_count" \| "both"` | which route concluded it |
| `at` | `number` | when |
| `divergent` | `boolean` | one route says complete, the other does not |

**Neither route may be load-bearing alone** (FR-022a). The completion signal has
never fired in production — `draft_archives` holds zero rows — and the pick count
depends on a draft length that has itself been wrong. `divergent` is surfaced to
the owner rather than resolved, because whichever fires alone on the next real
draft is the first evidence about which to trust (FR-022b).

---

## Derived view models

Computed from `RoomState` by pure selectors, so the React layer holds no logic.

### `BoardGrid`

`rounds × teams` of `Cell`, matching the ratified layout. A cell is `empty`,
`filled` (player, position, team) or `current`. The owner's column is marked.

Bounded by construction: a draft is `teams × rounds` cells, so FR-021 costs
nothing at the grid. **The unbounded thing is raw frames**, which are discarded
once applied — only materialised picks are retained.

### `RailEntry` — one recommended player as the 318px rail shows them

| Field | Notes |
|---|---|
| `playerId`, `name`, `position`, `team` | |
| `finalValue` | 006's |
| `headline` | the **largest-magnitude** adjustment's `reason`, or `forcedBy` when the pick is forced, or a plain "no rule applied" (FR-008) |
| `preferred` | 006's flag — badges the player without opening anything (FR-007) |
| `preferredValue` | what the preference contributed, `null` if not preferred |

`headline` is a `reduce` over 006's adjustments, not a judgement: the biggest
mover is the reason an owner would ask about first. It is **never empty** — that
is what makes "no bare names" (Constitution VII) true at a glance.

### `RosterView`

The owner's players by slot, plus what the league still requires — taken from
006's warnings rather than recomputed, so the screen and the engine cannot
disagree about what is unfilled.

---

## Validation rules

| Rule | Where enforced | Requirement |
|---|---|---|
| A recommendation from a superseded revision is discarded | `recommendationRevision !== revision` → not rendered | FR-016 |
| Duplicate frames are dropped, only a forward gap resyncs | `cursor` check, as `draftSocket.ts` already does | FR-013 |
| An epoch change discards state rather than merging | `epoch` compare | FR-012 |
| At most one recommendation request in flight | `inFlight` / `dirty` | FR-003 |
| `picksUntilMyTurn === null` renders as unknown, never "0" | selector | FR-010 |
| `order === null` says "not published", never invents one | selector | FR-017 |
| A withheld board renders the reason and remedy, no entries | `withholding` | FR-014 |
| Completion by either route, divergence visible | `Completion` | FR-022a/b |
| Raw frames are not retained after application | reducer | FR-021 |
