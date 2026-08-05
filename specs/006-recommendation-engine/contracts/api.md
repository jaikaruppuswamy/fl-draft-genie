# 006 Contracts

**Feature**: 006 | **Date**: 2026-08-05

Two contracts. The **engine contract** is the one 008 replays and 007 renders
against; it is a function signature, not an endpoint, and that is the point. The
**HTTP contract** is a thin shell around it plus the preferred-list CRUD.

Both are additive. Nothing in 001–005 or 010 changes shape.

---

## 1. The engine contract (pure)

```ts
// src/engine/recommend.ts — no platform imports, no clock, no I/O.
export function recommend(bundle: EngineBundle, state: EngineState): RankedBoard;
```

Shapes are specified in [data-model.md](../data-model.md). Three properties are
part of the contract, not implementation details:

1. **Determinism.** Same arguments ⇒ identical output, byte for byte after
   `JSON.stringify`. No `Date`, no `Math.random`, no ambient state. (FR-010,
   SC-003)
2. **Totality.** `entries` contains every available player, ordered, with no
   ties left unresolved — the sort falls through to `espn_player_id`. (FR-001,
   FR-017)
3. **Reconciliation.** For every entry,
   `finalValue − rawValue === sum(adjustments.magnitude)`. (FR-027, SC-014)

A consumer that holds a `RankedBoard` whose `revision` is behind the session's
current revision MUST discard it rather than display it. (FR-016)

---

## 2. HTTP

### `GET /api/leagues/:id/recommendations`

Auth: session cookie. 404 on a connection the account does not own.

**200**

```json
{
  "revision": 7,
  "withheld": null,
  "forced": false,
  "freshness": { "fetched_at": "2026-08-05T14:02:11.000Z", "stale": false },
  "warnings": [
    { "kind": "mandatory_unfilled", "detail": "K and D/ST unfilled, 4 picks left" }
  ],
  "round_value": 12.4,
  "shortlist": [
    {
      "player_id": 4362628,
      "name": "…",
      "position": "RB",
      "team": "SF",
      "rank": 1,
      "raw_value": 41.2,
      "final_value": 47.9,
      "preferred": true,
      "explanation": {
        "raw_value": 41.2,
        "final_value": 47.9,
        "round_value": 12.4,
        "adjustments": [
          { "rule": "offense",   "magnitude": 2.9,  "direction": "up",   "reason": "top-5 offense" },
          { "rule": "bye",       "magnitude": -1.6, "direction": "down", "reason": "bye clash with your RB1" },
          { "rule": "survival",  "magnitude": 3.1,  "direction": "up",   "reason": "unlikely to last to your next turn (12 picks)" },
          { "rule": "preferred", "magnitude": 2.3,  "direction": "up",   "reason": "on your preferred list" }
        ],
        "missing": [{ "input": "oline", "detail": "no curated O-line rank for this team" }],
        "alternatives": [{ "player_id": 3117251, "name": "…", "final_value": 46.4 }],
        "forced_by": null
      }
    }
  ],
  "entries": [
    { "player_id": 4362628, "name": "…", "position": "RB", "team": "SF",
      "rank": 1, "raw_value": 41.2, "final_value": 47.9, "preferred": true }
  ]
}
```

`shortlist` is the first `SHORTLIST_SIZE` (5) of `entries`, repeated with
explanations attached. Repetition is deliberate: a consumer that only wants the
answer reads `shortlist` and never walks `entries`.

**200 with `withheld` set** — the draft state is known-stale (FR-012, SC-007).
`entries` and `shortlist` are both empty. This is **not** an error status: the
question was answered, and the answer is "I will not guess".

```json
{
  "revision": 7,
  "withheld": { "reason": "not_receiving", "detail": "No tap heartbeat for 61s" },
  "shortlist": [], "entries": [], "warnings": [], "forced": false
}
```

`reason` reuses 005's `WithholdReason` union verbatim — `not_receiving`,
`incompatible`, `version_rejected` — rather than inventing a parallel
vocabulary.

**409 `no_projections`** — no serving projection set. Matches `/board`'s
existing behaviour for the same cause.

### `GET /api/leagues/:id/recommendations/players/:playerId`

The on-demand explanation for a player below the shortlist head (FR-009). Same
computation, one explanation returned. **404** if the player is not available.

### `GET /api/leagues/:id/preferred`

```json
{ "season": 2026, "players": [
  { "espn_player_id": 4362628, "name": "…", "position": "RB", "team": "SF", "on_board": true },
  { "espn_player_id": 15847,   "name": null, "position": null, "team": null,  "on_board": false }
]}
```

`on_board: false` is FR-021 in the contract: the row survives, the page can say
the player cannot be used, and the engine ignores it. `name: null` when the
player has left the board entirely and no name is available.

### `PUT /api/leagues/:id/preferred/:playerId`

Idempotent add. **204**. **404** if the player id is not in the board universe
at the time of the request — adding a player who never existed is a mistake worth
reporting; a player who *later* leaves the board is not.

### `DELETE /api/leagues/:id/preferred/:playerId`

Idempotent remove. **204** whether or not the row was there.

---

## Isolation (FR-020)

Every preferred-list query filters on `account_id` **in the SQL**, following the
pattern 005 established for `readBatchesAfter`. A missing or wrong check at the
route cannot expose another owner's list, because the query cannot see it. The
contract test asserts this by issuing a request for another account's connection
and requiring 404 — not an empty list, which would leak the connection's
existence.

---

## What does not change

- 005's WebSocket stream, event shapes, and `?since=` resume.
- The `/board` response (`adp` was already present).
- The tap protocol, in any respect.
- `draft_archives` / `draft_picks` — read-only here.
