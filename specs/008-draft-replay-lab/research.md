# Phase 0 Research: Draft Replay Lab

**Feature**: 008-draft-replay-lab | **Date**: 2026-08-05

Every finding below was checked against the shipped code, not inferred from the
roadmap. Three of them contradict what the roadmap says.

---

## §1 — What a replay actually needs, and where each piece comes from

The engine's input shapes are already split exactly along the line a replay
needs. `EngineBundle` is the slow half (board, signals, roster shape, preferred
list, ADP floor) and `EngineState` is the fast half (drafted set, my roster,
gap to next turn, remaining picks). A replay reconstructs the bundle **once per
draft** and the state **once per turn**.

**Decision**: the corpus entry's input snapshot *is* a serialized `EngineBundle`.
The replay deserializes it and calls `recommend(bundle, state)` — the same
function `src/api/recommendations.ts` calls in production.

**Rationale**: it makes FR-002 ("invoke the engine unmodified") structural rather
than aspirational. There is no adapter that could drift, no second assembly path
to keep in step, and the snapshot inherits Principle III for free — the board in
an `EngineBundle` is already scored in the league's own currency, so a replay
cannot accidentally score in generic PPR.

**Alternatives considered**:
- *Store raw projection rows and re-assemble the bundle at replay time.* Rejected:
  re-assembly needs `buildLeagueBoard` plus the league's scoring map plus the ADP
  floor detector, so the snapshot would be a recipe rather than a result and any
  change to the assembly would silently change historical replays.
- *Store the ranked board itself.* Rejected: that is the engine's **output**.
  Snapshotting it would make every replay return what the engine said in August
  no matter what the rules say today, which is the exact opposite of the point.

`deriveState()` (`src/engine/state.ts`) already produces the fast half from a
pick list, and computes `frontier = picks.length + 1`. So feeding it the picks
*before* overall N yields a state whose current pick is exactly N. No new
arithmetic.

---

## §2 — Where corpus entries come from (ratified: retained frames, not the archive)

| Source | Status | Verified how |
|---|---|---|
| `draft_archives` / `draft_picks` | **0 rows in production**; gated on 005 T045/T056 | schema + roadmap; archive path exists but has never run |
| `tap_batches` | **Retained and populated** | `migrations/0007_tap_batches.sql`; `scripts/export-tap-corpus.ts` reads it today |
| ESPN completed-draft view | Reliable for finished drafts | 005 Gate 0; `parseCompletedDraft()` already parses it |

**Decision**: build live-observed entries by folding retained relay batches
through the existing pure pipeline — `foldBatches()` → `reconcile()` — and
import others through `parseCompletedDraft()`.

**Rationale**: `reconcile()` is genuinely pure (checked: no `D1`, no `Env`, no
`fetch`, no `Date.now`), so it runs in a plain node process with no Durable
Object, no storage and no session. For a *finished* draft, draft-end detection is
irrelevant — every frame is already on disk, and the end of the file is the end
of the draft. That is what removes 008's dependency on 005's unfinished work.

**Alternatives considered**:
- *Wait for the archive path.* Rejected in clarify: it blocks the feature on work
  in another spec, while drafts happen this month.
- *Reimplement frame decoding in the lab.* Rejected outright. 010's oracle caught
  a wrong reading of `SELECTED`'s third field (agreeing on only 5 of 70 picks); a
  second decoder is a second chance to make that mistake, undetected.

`parseCompletedDraft()` needs no change: it already returns round, round-pick,
team, player, `keeper` and `autodrafted`, sorted by overall, and carries an
explicit comment that there is deliberately **no `> 0` test on playerId** — the
bug that made 010's capture report 66 of 72 picks.

---

## §3 — The corpus decays unless the snapshot is taken (the finding that reshaped the feature)

Two independent decay mechanisms, both verified in code:

1. **`pruneSets()`** (`src/db/projections.ts:114`) runs
   `DELETE FROM projection_sets WHERE season < ?` on every scheduled-maintenance
   pass, and `player_projections` cascades on `set_id`. The 2026 sets are deleted
   when the clock rolls to 2027.
2. **`signal_entries`** is `PRIMARY KEY (kind, pro_team_id)` — no season, no
   history — and `computeSignals()` re-runs in lockstep with every projection
   refresh. A draft's contemporaneous signals are gone within a day.

**Decision**: snapshot at admission; never read live tables at replay time.

**Rationale**: it converts fidelity from a property of *when you run the lab* into
a property of *the record*, and it is purely additive — 002's prune and 004's
recompute keep behaving exactly as they do now.

**Alternatives considered**:
- *Exempt referenced seasons from the prune.* Rejected in clarify: modifies shipped
  002 behaviour and does nothing at all for signals.
- *Accept the decay.* Rejected: it makes the corpus unusable for the tuning session
  the feature exists to enable.

**Consequences that must be stated, not buried:**
- An imported past-season draft can never be snapshotted, so it can never be
  replayed. This is why import has two distinct jobs (§5).
- The already-captured drafts can recover a board (2026 sets survive) but **not**
  their signals — those were recomputed within a day of capture. Their fidelity
  declaration will read *board reconstructed, signals present-day*, permanently.

---

## §4 — Choosing "the set that was serving at draft time"

`projection_sets` carries `season`, `status`, and `fetched_at`; multiple complete
sets exist per season (daily in Aug–Sep, plus a draft-day top-up). `getServingSet`
takes the newest complete set — correct for production, wrong for a replay of a
draft that ran three weeks ago.

**Decision**: a pure `chooseSetAt(rows, at)` selecting the newest `complete` set
with `fetched_at <= at`, in the lab core and unit-tested; the admitting script
supplies candidate rows.

**Rationale**: it is a decision, so it belongs in the tested pure core; fetching
rows is I/O, so it belongs in the script. Same split the rest of this codebase
uses. Adding a query to `src/db/projections.ts` for a lab-only need would put
lab concerns into worker code for no benefit.

**Edge case that must not be papered over**: if no complete set predates the
draft, there is no contemporaneous board and the entry is **unreplayable** — not
"use the nearest one". FR-019d.

---

## §5 — Import does two different jobs

| Season | Board exists? | Use class |
|---|---|---|
| Covered by the pipeline (2026+) | yes — matched by `chooseSetAt` | **replayable** |
| Earlier (2025 and back) | no, and unobtainable | **pick-sequence-only** |

ESPN serves preseason projections for the *current* season only, so a 2024 board
cannot be fetched at any price. Running the engine over a 2024 pick sequence
against a 2026 board would produce numbers that look like evidence and are not.

**Decision**: the use class is a permanent property written at admission, and the
replay refuses pick-sequence-only entries structurally rather than by convention.

**What the pick-sequence-only entries are for**: measuring the distribution of
(pick overall − player ADP) across real drafts. That is the only empirical
grounding the opponent model will ever have, and it is the difference between a
noise parameter chosen from data and one chosen from taste.

---

## §6 — Sweeping a constant without modifying the engine

The tension: FR-014 requires sweeping a tuning constant across values in one run;
FR-002 forbids modifying the engine and FR-018 forbids writing to its constants.
But `src/engine/constants.ts` exports module-level `const` bindings that six
modules import directly, so the value is fixed at module-evaluation time.

**Decision**: substitute the *module*, per value, using vitest's
`vi.resetModules()` + `vi.doMock(...)` + dynamic `import()`, with the mock built
from `vi.importActual` so only the swept field differs.

```
vi.resetModules()
vi.doMock(".../engine/constants", async () => {
  const actual = await vi.importActual(".../engine/constants")
  return { ...actual, WEIGHT: { ...actual.WEIGHT, bye: value } }
})
const { recommend } = await import(".../engine/recommend")
```

**Rationale**: nothing is written, no file is generated, the engine's source is
untouched, and every unswept constant provably comes from the real module. vitest
3.2 is already a dependency, and the lab's tests already run in a node project.

**Alternatives considered**:
- *Add a tuning parameter to `recommend()`.* Rejected: changes 006's interface for
  a lab-only need, and puts a config-shaped seam into a rule set the constitution
  says is code, not config (Principle IV).
- *Generate a temporary constants file per value.* Rejected: writing into
  `src/engine/` is exactly what FR-018 prohibits, and a crashed run leaves the
  engine modified.
- *Spawn a child process per value with a module-resolution loader.* Rejected as
  more machinery for the same result (Principle VIII).

**Note on the ordinary case**: comparing two rule sets does *not* need any of this.
The maintainer edits `constants.ts`, re-runs, and diffs against the committed
baseline — the file change and the scorecard change land in the same review.
Module substitution is only for the many-values-in-one-run case.

---

## §7 — Determinism, and how it is actually enforced

FR-009/FR-013 and SC-002 all rest on identical output across runs. Three sources
of nondeterminism to close:

1. **Map/Set iteration order.** `EngineBundle` uses both. Insertion order is
   stable in JS, but the *codec* must sort on serialize so a snapshot written
   from two different query orderings is byte-identical.
2. **Floating point presentation.** Same operations give the same bits, but
   `JSON.stringify` of a float is long and noisy in a diff. The scorecard rounds
   to 4 decimal places at serialization — enough to see a real movement, coarse
   enough that formatting never masquerades as a change.
3. **Randomness.** `Math.random()` is banned in the lab core. Simulation uses a
   seeded PRNG (mulberry32, ~5 lines) with the seed recorded in the output.

**Enforcement**: canonical serialization (sorted keys, fixed rounding), and a
determinism test that runs the same corpus twice and compares. 006's own test
suite already had a `Math.random()` slip caught in review — a structural guard
that greps the lab core for `Math.random` and `Date.now` costs nothing and does
not depend on anyone remembering.

---

## §8 — Where the code lives, and how "no deployed surface" is proven

**Decision**: pure core in `src/lab/`, I/O in `scripts/lab-*.ts`, tests in
`tests/lab/`, fixtures in `tests/fixtures/lab/`. No migration, no D1 table, no
endpoint, no page.

**Rationale**: `src/lab/` sits beside `src/engine/` and `src/draft/` and imports
them without cross-tree paths or a third tsconfig. `tap/` is top-level only
because it targets the browser and its DOM globals conflict with workers-types —
the lab has no such conflict, so a separate tree would be complexity for its own
sake (Principle VIII).

**How FR-035 is proven rather than promised**: a structural guard asserting that
no file outside `src/lab/` imports from `src/lab/`, and that `src/index.ts`'s
reachable import graph never includes it. This is the same technique 006 used for
FR-010/FR-011 — and 005 is the cautionary tale: `writeArchive` was built, tested,
and never called, and only a structural check would have noticed.

**Type-checking**: `tests/lab/**` stays inside the root tsconfig (it imports
`src/engine` and `src/draft`, exactly like `tests/engine` and `tests/draft` do).
That means **no `node:fs` in the core or its tests** — the root tsconfig has no
node types. Tests load fixtures via `import.meta.glob(..., '?raw')`, the mechanism
`tests/engine/purity.test.ts` already uses. Scripts are outside the tsconfig
include and use `node:fs` freely, as `scripts/export-tap-corpus.ts` does.

---

## §9 — Privacy: what carries identities, and where it is stopped

| Source | Carries names/GUIDs? | Stop |
|---|---|---|
| `tap_batches` | No — numeric only, filtered by the tap *and* re-asserted at ingest | already clean |
| ESPN completed-draft view | **Yes** — authenticated read returns `members[]` with real names and SWIDs | screened at admission, before any write |

**Decision**: admission screens before writing, reusing `memberNamesIn()` from
`scripts/sanitize-espn.ts` rather than writing a second matcher.

**Rationale**: `scripts/privacy-sweep.ts` carries a comment recording exactly this
lesson — its first version had *its own copy* of the matching logic, and the copy
was the thing that was wrong; real member names shipped to a public repo in two
fixtures while the sweep printed "clean".

`privacy-sweep.ts` already walks `tests/fixtures`, so fixtures written under
`tests/fixtures/lab/` are covered by `npm test` from the first commit with no
change to its ROOTS list. Verified by reading its ROOTS array.

**Isolation (FR-027)**: the admitting query is scoped by `account_id` — the same
scoping `tap_batches` and `preferred_players` already enforce in the query rather
than at a call site someone can forget.

---

## §10 — Sizing, so "a few hundred KB" is a measurement and not a guess

A snapshot is one serialized `EngineBundle`. The dominant term is
`players: BoardEntry[]` — ten scalar fields per player, ~522 players in the
current serving set. Signals are 3 kinds × 32 teams; `proTeamByPlayer` is trimmed
to board players only (a drafted player missing from the board is already
tolerated by `deriveState`, so carrying the whole universe buys nothing).

Estimate: **~100–250 KB per draft**, against the 224 KB `capture-2026.jsonl`
already committed. Ten drafts is a couple of megabytes — acceptable for something
that must be reviewable in a diff.

**Performance**: ~500 players × ~12 owner turns × 10 drafts ≈ 120 `recommend()`
calls. SC-001's five-minute bar is a ceiling, not a target; the expected figure is
seconds, and deserialization dominates.

---

## §11 — Replay must not inherit a live-only condition

`EngineState.withholding` is 005's verdict about whether the tap is still
delivering. In a replay there is no tap and no liveness, so the condition cannot
arise.

**Decision**: the replay sets `withholding: null` **explicitly**, at one named
place, with the reason recorded — never by letting a default fall through.

**Rationale**: this is the difference between a documented divergence from
production and an accident that looks like agreement. It is also the shape of the
`totalPicks = 0` bug from 006, where a value that meant "unknown" was read as a
claim.

---

## Resolved unknowns

| Unknown from Technical Context | Resolution |
|---|---|
| How to vary a constant without touching the engine | §6 — vitest module substitution |
| How to keep a corpus replayable past its season | §3 — snapshot at admission |
| Which projection set a past draft used | §4 — `chooseSetAt`, unreplayable if none predates |
| Whether the archive path can be the source | §2 — no; retained frames instead |
| How to prove no deployed surface | §8 — structural import guard |
| How to keep replays deterministic | §7 — canonical codec, seeded PRNG, no clock |

No unresolved NEEDS CLARIFICATION remain.
