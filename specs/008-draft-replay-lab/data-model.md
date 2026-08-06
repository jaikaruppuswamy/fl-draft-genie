# Phase 1 Data Model: Draft Replay Lab

**Feature**: 008-draft-replay-lab | **Date**: 2026-08-05

**No database schema.** The corpus lives as committed fixtures (FR-036), so
there is no migration in this feature. Everything below is a file format or an
in-memory shape. The formats are a real contract nonetheless — a fixture written
today must be readable a year from now, which is the whole point of snapshotting.

---

## 1. `CorpusEntry` — one draft

The unit of the corpus. Written once at admission, never edited by a run.

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | `number` | Bumped when the fixture shape changes. A reader MUST refuse an unknown version rather than guess. |
| `id` | `string` | Stable, derived from league + season. The fixture filename. |
| `season` | `number` | |
| `espnLeagueId` | `string` | Numeric ESPN id. No name, ever. |
| `provenance` | `"live_frames" \| "espn_import" \| "archive"` | How the picks were obtained. |
| `provenanceClass` | `"real" \| "test"` | **FR-027a.** A test run is a mock or rehearsal. |
| `useClass` | `"replayable" \| "pick_sequence_only"` | **FR-025, FR-020b.** Permanent. |
| `unreplayableReason` | `string \| null` | Required non-null when `useClass` is `pick_sequence_only`. |
| `teamCount` | `number` | |
| `roundCount` | `number` | |
| `totalPicks` | `number` | Teams × rounds, **or** the reconciled count where keepers make those differ. Never assumed. |
| `myTeamId` | `number \| null` | Null ⇒ no owner turns ⇒ not replayable. |
| `order` | `number[]` | Round-1 pick order. Empty ⇒ not replayable (FR-025). |
| `picks` | `CorpusPick[]` | Sorted by `overall`, contiguous from 1. |
| `keepers` | `{ teamId, playerId }[]` | **Every** team's, not only the owner's (FR-024). |
| `startedAt` | `string \| null` | ISO. Drives `chooseSetAt` (FR-020a). |
| `completedAt` | `string` | ISO. |
| `oracle` | `OracleCheck \| null` | Comparison against ESPN's completed-draft view. |
| `gaps` | `number[]` | Overall numbers known to be missing (FR-019g). Non-empty ⇒ unreplayable. |

### `CorpusPick`

| Field | Type | Notes |
|---|---|---|
| `overall` | `number` | 1-based. |
| `round` | `number` | |
| `roundPick` | `number` | |
| `teamId` | `number` | |
| `playerId` | `number` | **Signed.** D/ST ids are ~−16000; nothing may filter on sign (FR-026). |
| `keeper` | `boolean` | |
| `autodrafted` | `boolean` | |
| `observedAt` | `string \| null` | Present only for `live_frames`. The one thing import cannot supply. |
| `observedEpoch` | `number \| null` | Stamps compare only *within* an epoch — the tap re-anchors across sleep. |

### `OracleCheck`

| Field | Type | Notes |
|---|---|---|
| `checkedAt` | `string` | |
| `agreed` | `number` | Picks matching ESPN's view. |
| `total` | `number` | |
| `divergences` | `{ overall, ours, theirs }[]` | **Recorded, never resolved** (FR-022). |

### Validation rules

1. `picks` sorted ascending by `overall`, no duplicates, contiguous from 1 unless
   the missing numbers appear in `gaps`.
2. `useClass === "replayable"` requires: non-null `myTeamId`, non-empty `order`,
   empty `gaps`, and an accompanying `InputSnapshot`.
3. `useClass === "pick_sequence_only"` requires a non-null `unreplayableReason`.
4. No field anywhere may contain a GUID, a URL, or a non-numeric identifier —
   asserted by `scripts/privacy-sweep.ts`, which already walks `tests/fixtures`.
5. An unknown `formatVersion` is a hard error.

### Lifecycle

```
admitted ──► replayable ──────────────► (permanent; snapshot makes it immune to
   │           (has InputSnapshot)        prune and signal recompute)
   └────────► pick_sequence_only ──────► (permanent; engine never runs on it)
```

There is no transition between use classes. A `pick_sequence_only` entry cannot
later become replayable, because the board it would need never existed.

---

## 2. `InputSnapshot` — the engine's slow half, frozen

A serialized `EngineBundle` (`src/engine/types.ts`). Stored as a sibling file to
the entry. **This is the record that makes the corpus outlive `pruneSets()` and
the in-place overwrite of `signal_entries`.**

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | `number` | |
| `entryId` | `string` | Must match its `CorpusEntry`. |
| `players` | `BoardEntry[]` | Already scored in the league's own currency (Principle III). |
| `signals` | `{ kind, proTeamId, value }[]` | Flattened from the `Map<kind, Map<team, …>>`; sorted for canonical output. |
| `proTeamByPlayer` | `[playerId, proTeamId][]` | Trimmed to board players. |
| `roster` | `RosterSnapshot` | Slot shape — drives roster needs. |
| `teamCount` | `number` | |
| `preferred` | `number[]` | Sorted. The preferred list has no history, so this is a snapshot too. |
| `adpFloor` | `number \| null` | ESPN's saturation floor as detected then. |
| `freshness` | `{ fetchedAt, stale }` | |
| `signalFreshness` | `{ kind, computedAt, provenance }[]` | |
| `sourceSetRef` | `string` | Which `projection_sets` row this came from. |
| `sourceSetFetchedAt` | `string` | What `chooseSetAt` matched. |

### Codec

`Map` and `Set` do not survive `JSON.stringify`, so the codec is explicit in both
directions and **sorts on serialize** — a snapshot built from two different query
orderings must be byte-identical (research §7).

```
snapshotToBundle(json) -> EngineBundle    // arrays -> Map/Set
bundleToSnapshot(bundle) -> json          // Map/Set -> sorted arrays
```

Round-trip identity is a test, not an assumption.

---

## 3. `Fidelity` — what was reconstructed and what was borrowed

**FR-015/FR-016.** Attached to every run. Not optional, and there is no code path
that produces a run without one.

| Field | Type | Notes |
|---|---|---|
| `board` | `"as_of" \| "present_day" \| "unavailable"` | `as_of` when `chooseSetAt` found a set predating the draft. |
| `signals` | `"as_of" \| "present_day" \| "unavailable"` | `as_of` only for drafts admitted *while running*. Retro-admitted 2026 drafts are `present_day` — permanently. |
| `preferred` | `"as_of" \| "present_day"` | |
| `scoring` | `"as_of" \| "present_day"` | The league snapshot is current, not versioned. |
| `notes` | `string[]` | Human-readable reasons, e.g. "signals recomputed since capture". |

A run whose `board` is `unavailable` is not a run: it is refused (FR-016).

---

## 4. `TurnObservation` — the unit of evidence

One of the owner's turns.

| Field | Type | Notes |
|---|---|---|
| `overall` | `number` | |
| `round` / `roundPick` | `number` | |
| `engineHead` | `{ playerId, name, finalValue, rawValue }` | The engine's first choice. |
| `shortlist` | `Recommendation[]` | 006's output verbatim, explanations included (Principle VII). |
| `actual` | `{ playerId, rank, finalValue } \| null` | **Null means the drafted player was not on the board** — stated, not an error (FR-005). |
| `gapToHead` | `number \| null` | `engineHead.finalValue − actual.finalValue`. |
| `gapInRounds` | `number \| null` | The same gap divided by `roundValue`. **The comparable unit across leagues.** |
| `roundValue` | `number` | |
| `forced` | `boolean` | FR-025 in 006 — the engine was not choosing. |
| `warnings` | `Warning[]` | |
| `decisiveRule` | `AdjustmentRule \| null` | Non-null when the head under `finalValue` differs from the head under `rawValue`; names the largest-magnitude adjustment on the new head. Derived from the engine's own output — no second ranking implementation. |

---

## 5. `Scorecard` — an aggregate over one run

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | `number` | |
| `ruleSet` | `RuleSetIdentity` | **FR-011.** Without it a scorecard is a number with no referent. |
| `fidelity` | `Fidelity` | Per entry, and rolled up. |
| `entries` | `{ entryId, turns: TurnObservation[] }[]` | Only `replayable` + `real` entries (FR-027b). |
| `excluded` | `{ entryId, reason }[]` | Test runs and pick-sequence-only entries, named rather than silently dropped. |
| `behavioural` | see below | The comparison basis (FR-017). |
| `outcome` | `OutcomeMeasures \| null` | **FR-017a.** Null until the season has been played. Never defaulted. |
| `hash` | `string` | Of the canonical serialization. Determinism check. |

### `behavioural`

- `turnCount`
- `headAgreementRate` — turns where the engine's first choice was the player taken
- `actualRankDistribution` — where the taken player sat in the engine's ordering
- `meanGapInRounds`, `medianGapInRounds`
- `decisiveRuleCounts` — per rule, how often it changed the head
- `forcedTurnCount`

**None of these is a quality score, and that is deliberate.** They describe what
the engine did; they do not claim it was right. FR-017 forbids reporting a
projection-derived quality number as evidence of improvement, and every measure
above is descriptive rather than evaluative.

### `RuleSetIdentity`

| Field | Type | Notes |
|---|---|---|
| `constants` | `Record<string, number>` | Flattened from `src/engine/constants.ts`, e.g. `WEIGHT.bye`. |
| `engineVersion` | `string` | Content hash of `src/engine/*.ts`. Catches a rule change that left the constants alone. |

### `OutcomeMeasures` (reserved, populated only after a season is played)

| Field | Type |
|---|---|
| `season` | `number` |
| `actualPointsSource` | `string` |
| `ownerRosterActual` | `number` |
| `engineRosterActual` | `number \| null` — simulation only |

---

## 6. `Comparison` — two scorecards, same corpus

**FR-012.** Reports only what moved.

| Field | Type | Notes |
|---|---|---|
| `baseline` / `candidate` | `RuleSetIdentity` | |
| `threshold` | `{ rankMovement, valueInRounds }` | **Defaults are fixed, not per-run**: `rankMovement: 3` positions, `valueInRounds: 0.1`. Exported as one named constant from `src/lab/compare.ts` and **stated in every comparison's output**, so an unchanged turn is distinguishable from one that moved below the bar — and so two reports are comparable. A threshold each run picks for itself makes them silently not. |
| `headChanges` | `{ entryId, overall, from, to, deltaInRounds }[]` | |
| `movements` | `{ entryId, overall, maxRankDelta, valueDeltaInRounds }[]` | Only beyond threshold. |
| `aggregateDeltas` | partial `behavioural` | |
| `determinismFailure` | `boolean` | **FR-013.** True when identical rule sets produce a non-empty diff. Reported as a failure, never as a rule effect. |

---

## 7. `SweepDefinition` and `SweepReport`

**FR-014.** A sweep definition is a committed artifact, so the sweep that was run
is itself reviewable (FR-038).

| `SweepDefinition` | Type |
|---|---|
| `name` | `string` |
| `constantPath` | `string` — e.g. `WEIGHT.bye` |
| `values` | `number[]` |

`SweepReport`: one `Scorecard` per value plus the pairwise `Comparison` against
the first, so the *shape* of the effect is visible rather than a before/after pair.

---

## 8. `OpponentModel` and `SimulatedDraft` (US4)

| `OpponentModel` | Type | Notes |
|---|---|---|
| `kind` | `"adp_noise"` | |
| `noiseSd` | `number` | In ADP positions. **Characterised from pick-sequence-only entries** (FR-020c), not chosen by taste. |
| `seed` | `number` | Recorded in every result (FR-029). |

`SimulatedDraft` carries the resulting picks, the owner's roster, the model
identity and the seed, and is **flagged model-dependent** (FR-031) so it can
never be filed beside a shadow replay as equal evidence.

---

## Entity relationships

```
CorpusEntry ──1:0..1── InputSnapshot        (required iff replayable)
     │
     └──1:N── CorpusPick, keepers

Scorecard ──N:1── RuleSetIdentity
     ├──1:N── TurnObservation   (only from replayable + real entries)
     ├──1:1── Fidelity
     └──0:1── OutcomeMeasures   (null until the season is played)

Comparison ──2:1── Scorecard
SweepReport ──1:N── Scorecard
SimulatedDraft ──N:1── OpponentModel
```
