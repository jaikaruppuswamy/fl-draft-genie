---

description: "Task list for 008-draft-replay-lab"
---

# Tasks: Draft Replay Lab (008)

**Input**: Design documents from `specs/008-draft-replay-lab/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/cli.md](contracts/cli.md), [contracts/corpus.md](contracts/corpus.md), [quickstart.md](quickstart.md) — and the shipped 001–007 + 010 build.

**Tests**: requested, and unavoidable. Five of this feature's ten success
criteria (SC-002, SC-004, SC-006, SC-009, SC-010) are assertions, not behaviours
— there is no way to satisfy them except with a test. The pure core gets its
tests **first**, as `reconcile.ts` (005), `recommend.ts` (006) and
`draftRoom.ts` (007) all did.

**Mutation testing is the acceptance bar**, not line coverage. A lab whose own
tests pass against a broken lab is worse than no lab: it produces numbers that
look like evidence. 005 shipped two tests that survived their own mutations.

**Revised after `/speckit-analyze`** — one CRITICAL, three HIGH and eight
MEDIUM/LOW findings, all fixed here. Task IDs were renumbered rather than
suffixed, since no task had been started. The substantive changes: **Gate 0
(T001) is new and blocking**; T002 now carries the vitest exclude the previous
version omitted; T034 moves the engine hash out of the pure core; T062 measures
the Worker bundle rather than the SPA; and six properties the spec argued for but
nothing asserted now have tasks (T015, T021, T025, T051, plus the extended guards
in T012 and T013).

## Format: `[ID] [P?] [Story] Description`

- **[P]** — parallelisable: a **different file** from every other task that could
  run alongside it, and no dependency on an incomplete task
- **[US1]…[US4]** — the user story a task serves; absent for Setup, Foundational
  and Polish

## Path Conventions

`src/lab/` (pure core), `scripts/lab-*.ts` (I/O), `tests/lab/` (node project),
`tests/fixtures/lab/` (corpus). **No migration, no endpoint, no page, no new
dependency.**

`tests/lab/**` stays inside the root tsconfig, which has **no node types** — so
no `node:fs` in the core or its tests. Fixtures load via the literal
`import.meta.glob(..., '?raw')` form; Vite only rewrites the literal call, so it
cannot be aliased or factored into a helper. Scripts sit outside the tsconfig
include and use `node:fs` freely.

**The corollary bit an earlier draft of this file**: `import.meta.glob` exists
only under Vite/vitest, and `node:fs` exists only in scripts. Anything needing to
*read source or fixtures* must therefore live on the correct side of that line —
see T034, where the previous version put a file hash somewhere neither mechanism
was available.

## Why admission sits in User Story 1

The plan sequenced admission as its own phase. It is folded into US1 here because
US1's value is explicitly "over a **real** recorded draft", and admission is what
produces one — US1 on a synthetic fixture proves the code works, not the feature.
US3 remains the ESPN-import route, which is a genuinely separate capability with
a separate independent test.

## Prerequisites already satisfied

Do **not** rebuild these. Each was verified in the source during planning.

- **The frame pipeline** — `foldBatches()` (`src/draft/feed.ts`) and
  `reconcile()` (`src/draft/reconcile.ts`) turn relay batches into picks and are
  genuinely pure: no D1, no `Env`, no `fetch`, no `Date.now`. A second decoder is
  the single worst idea available in this feature.
- **The completed-draft parser** — `parseCompletedDraft()`
  (`src/espn/parsers.ts`) already returns round, round-pick, team, player,
  `keeper` and `autodrafted`, sorted, with **no `> 0` test on `playerId`**.
- **The engine** — `recommend()` and `deriveState()` are called as production
  calls them. Nothing here reimplements, wraps or approximates a rule (FR-002).
- **The name matcher** — `memberNamesIn()` (`scripts/sanitize-espn.ts`). Import
  it. Its own history is the argument: `privacy-sweep.ts` once carried a *copy*
  of this logic, the copy was wrong, and real member names shipped to a public
  repo while the sweep printed "clean".
- **The privacy sweep's coverage** — `scripts/privacy-sweep.ts` already walks
  `tests/fixtures` **and** `src`, so lab fixtures and lab code are swept from the
  first commit. Its ROOTS array needs no change.
- **The passivity guard pattern** — `tests/tap/passivity.test.ts` asserts
  Constitution VI against the shipped artifact. T013 follows it.
- **The corpus export pattern** — `scripts/export-tap-corpus.ts` shows the
  wrangler-query-then-screen-then-write shape the admitting scripts follow.

---

## Phase 1: Setup

**Purpose**: settle the one unverified external premise, then make a lab test
runnable.

- [ ] T001 **GATE 0 — verify ESPN still serves past-season completed drafts** before any dependent code exists. Fetch `mDraftDetail` for one league with `seasonId` set to a prior season and record in [research.md](research.md) whether `draftDetail.picks` comes back populated. **This is a constitution MUST** (Development Workflow: an unverified external premise is verified first, in the cheapest possible experiment) and it is the 005 Gate 0 pattern, where one evening's capture disproved a source eight phases had assumed. **If it fails**: `pick_sequence_only` has no source, so US3 reduces to current-season import, T052 has no data, and T055's noise parameter stays an assumption — record all three consequences in [research.md](research.md) and [spec.md](spec.md) rather than proceeding as though the corpus were coming
- [ ] T002 Add a `lab` project (node environment, `include: ["tests/lab/**/*.test.ts"]`) to `vitest.config.ts` **and add `tests/lab/**` to the `exclude` array in `vitest.workers.config.ts`**. Both halves in one task: that config's include glob is `tests/**/*.test.ts`, and its own comment records that without a matching exclude the workers pool *also* collects the node-project tests and they fail there
- [ ] T003 [P] Add `lab:admit`, `lab:import`, `lab:run`, `lab:behaviour`, `lab:simulate` and `lab:sweep` scripts to `package.json` per [contracts/cli.md](contracts/cli.md)
- [ ] T004 [P] Create `tests/fixtures/lab/README.md` recording the format contract, the forbidden-field list, and the "no timestamps of convenience" rule from [contracts/corpus.md](contracts/corpus.md)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the corpus types, codec, invariants and guards every story needs.
**No user story can start until this phase is done.**

- [ ] T005 Define `CorpusEntry`, `CorpusPick`, `InputSnapshot`, `Fidelity`, `OracleCheck`, use class and provenance class in `src/lab/corpus.ts` per [data-model.md](data-model.md)
- [ ] T006 Write invariant tests FIRST in `tests/lab/corpus.test.ts`: contiguous picks unless in `gaps`; `replayable` requires non-null `myTeamId`, non-empty `order`, empty `gaps` and a matching snapshot; `pick_sequence_only` requires a non-null reason and is **retained rather than discarded** (FR-025); unknown `formatVersion` is a hard error; **a D/ST pick at −16001 and the −1 sentinel are handled distinctly and neither is filtered on sign**
- [ ] T007 Implement the invariant checks in `src/lab/corpus.ts` so every failure names the entry and the invariant — never a silently skipped draft
- [ ] T008 [P] Write codec tests in `tests/lab/codec.test.ts`: `EngineBundle` → snapshot → `EngineBundle` round-trips with `Map`/`Set` restored; two different input orderings produce **byte-identical** output; scorecard numbers round to 4dp
- [ ] T009 Implement `bundleToSnapshot` / `snapshotToBundle` and the canonical serializer (sorted keys, sorted arrays, fixed rounding, two-space indent, trailing newline) in `src/lab/codec.ts`
- [ ] T010 [P] Write `chooseSetAt` tests in `tests/lab/setchoice.test.ts`: newest `complete` set with `fetched_at <= at`; `building` sets ignored; **no set predating the draft returns null, never the nearest one**
- [ ] T011 Implement `chooseSetAt(rows, at)` in `src/lab/setChoice.ts`
- [ ] T012 [P] Write the structural guard in `tests/lab/boundary.test.ts` reading source with `import.meta.glob`: no file outside `src/lab/` imports from `src/lab/`; `src/index.ts`'s reachable graph excludes it; `src/lab/**` contains no `Math.random`, `Date.now`, `new Date(` or `fetch(`; **and `scripts/lab-run.ts` / `lab-simulate.ts` / `lab-behaviour.ts` contain no D1 or wrangler call** — a *run* reads committed fixtures only, and only the admitting scripts touch production (FR-035, FR-036, FR-037)
- [ ] T013 [P] Write the passivity guard in `tests/lab/passivity.test.ts`, modelled on `tests/tap/passivity.test.ts`: no file in `src/lab/**` or `scripts/lab-*.ts` opens a WebSocket, an EventSource, or any connection to an ESPN draft-room host, and none issues a non-GET request to ESPN. **Constitution VI is a MUST and had no guard** (FR-033)
- [ ] T014 Hand-author a small synthetic corpus entry and snapshot (6 teams, 3 rounds) at `tests/fixtures/lab/synthetic-2026.{draft,inputs}.json` so every later phase is testable without D1, ESPN, or a real draft

**Checkpoint**: `npm test` green in all four projects, guards firing, a corpus
entry loadable.

---

## Phase 3: User Story 1 — Show me what the engine would have done, turn by turn (P1) 🎯 MVP

**Goal**: walk a real completed draft, and at every one of the owner's turns show
the board the engine would have produced, beside the player actually taken.

**Independent test**: replay one recorded draft end to end and confirm every
owner turn yields a ranked board, an explanation for the shortlist head, and the
rank the drafted player held — with no live draft, no network and no clock.

### Replay core

- [ ] T015 [US1] Write replay tests FIRST in `tests/lab/replay.test.ts`: owner turns derived from **round + order** and never from a field on a pick; state before turn N contains exactly picks 1…N−1; keepers unavailable from pick one on every team; the drafted player's rank and value gap reported; **a drafted player absent from the board yields `actual: null` and the turn still resolves**; and **the engine's `warnings` are carried through on every turn**, which FR-003 requires and `TurnObservation` already models
- [ ] T016 [US1] Implement `replayEntry()` in `src/lab/replay.ts` — `deriveState()` per turn, then `recommend(bundle, state)`, calling the engine exactly as `src/api/recommendations.ts` does
- [ ] T017 [US1] Set `withholding: null` at **one named place** in `src/lab/replay.ts` with the reason recorded in a comment: there is no tap in a replay, so the condition cannot arise. Never let a default fall through (research §11)
- [ ] T018 [P] [US1] Derive `decisiveRule` in `src/lab/replay.ts` from the engine's own output only — the head under `finalValue` versus the head under `rawValue` — with no second ranking implementation
- [ ] T019 [US1] Write a determinism test in `tests/lab/replay.test.ts`: the same entry replayed twice produces an identical hash, **and a companion assertion proving the check can fail** when a value is perturbed (SC-002)
- [ ] T020 [US1] Write `tests/lab/durability.test.ts` asserting the replay reads only the entry and its snapshot — its signature admits no database, and a bundle whose source set no longer exists replays identically (FR-019b, **SC-009**)
- [ ] T021 [US1] Assert the **shadow property** in `tests/lab/replay.test.ts`: the sequence of picks the replay applies is byte-equal to the entry's own picks, and the engine's preference never alters it (FR-007). Distinct from the state-construction assertions in T015, and the property that will blur once `simulate.ts` sits beside `replay.ts`
- [ ] T022 [US1] Implement `scripts/lab-run.ts` single-entry mode: per-turn output with the engine's head, the actual pick, its rank, and the gap in **round-value units**

### Admission from retained frames

Without this, US1 works only on the synthetic fixture. This is what points it at
a real draft — and, per the ratified decision, it does **not** wait for 005's
archive path.

- [ ] T023 [US1] Implement `scripts/lab-admit.ts`: query `tap_batches` **scoped by `account_id` in the query itself** (FR-027), fold through `foldBatches()` → `reconcile()`, emit a `CorpusEntry`
- [ ] T024 [US1] Capture the input snapshot in `scripts/lab-admit.ts`: `chooseSetAt(sets, startedAt)`, assemble the `EngineBundle`, serialize via the codec, and record `sourceSetId` / `sourceSetFetchedAt`
- [ ] T025 [US1] Assert in `tests/lab/boundary.test.ts` that the admitting scripts issue **only reads** against `projection_sets`, `player_projections` and `signal_entries` — no `INSERT`, `UPDATE`, `DELETE` or retention flag. **This is the guarantee that made snapshotting the right answer** over exempting seasons from the prune: the design is additive, and 002's and 004's shipped behaviour is untouched (FR-019c)
- [ ] T026 [US1] Emit the `Fidelity` declaration in `scripts/lab-admit.ts` — `signals: "present_day"` for any draft admitted after the fact, stated in the output rather than implied (FR-015)
- [ ] T027 [US1] Refuse to snapshot when no complete set predates the draft: mark the entry unreplayable with the reason, never substitute the nearest set (FR-019d, FR-016)
- [ ] T028 [US1] Detect missing overall numbers in `scripts/lab-admit.ts`, record them in `gaps`, and mark the entry unreplayable rather than presenting a shorter draft as complete (FR-019g)
- [ ] T029 [US1] Screen before writing in `scripts/lab-admit.ts` — GUID, URL and `memberNamesIn()` — and exit non-zero **without writing** on any hit (FR-021)
- [ ] T030 [US1] Make `--class real|test` **required with no default** in `scripts/lab-admit.ts`; misclassifying a mock as real poisons every later comparison invisibly (FR-027a)
- [ ] T031 [US1] Re-admit the drafts captured to date with `--class test` and commit them as harness fixtures, retained rather than deleted (FR-027c)

**Checkpoint**: a real draft replays, turn by turn, from committed fixtures.

---

## Phase 4: User Story 2 — Tell me whether a rule change made things better or worse (P2)

**Goal**: change a weight, re-run the corpus, and see exactly what moved.

**Independent test**: record a baseline, change one constant, re-run, and confirm
the report names exactly the turns whose outcome changed — and that changing
nothing produces an empty diff.

- [ ] T032 [US2] Write scorecard tests in `tests/lab/scorecard.test.ts`: only `replayable` **and** `real` entries contribute; test runs and pick-sequence-only entries appear in `excluded[]` with reasons; `outcome` is null and never defaulted
- [ ] T033 [US2] Implement `src/lab/scorecard.ts` with the behavioural measures from [data-model.md](data-model.md) — head agreement, actual-rank distribution, mean/median gap in rounds, decisive-rule counts, forced-turn count. **No aggregate derived from projections may be emitted as a quality score** (FR-017)
- [ ] T034 [US2] Implement `RuleSetIdentity` as a **parameter** of `src/lab/scorecard.ts`, not something it computes: the flattened constants come from importing `src/engine/constants`, but the **content hash of `src/engine/*.ts` is computed in `scripts/lab-run.ts` with `node:fs` and passed in**. The pure core cannot read files (root tsconfig, no node types) and the script runs under tsx where `import.meta.glob` does not exist — neither mechanism is available inside the core. Same pure-core/thin-IO split as `chooseSetAt` (FR-011)
- [ ] T035 [US2] Reserve the `outcome` block for actual season points, printed as explicitly empty until the season is played — never omitted, never filled with a projection-derived stand-in (FR-017a)
- [ ] T036 [P] [US2] Write comparison tests in `tests/lab/compare.test.ts`: head changes named; movements reported only beyond threshold; **the threshold is stated in the output**; identical rule sets produce an empty diff; a non-empty diff under identical rule sets is flagged `determinismFailure`, not a rule effect (FR-013)
- [ ] T037 [US2] Implement `src/lab/compare.ts` with the **default threshold fixed and named in one exported constant**: `rankMovement: 3` positions, `valueInRounds: 0.1`. Both are reported in every comparison. A threshold that each run picks for itself makes two reports incomparable, which is the failure this fixes (FR-012)
- [ ] T038 [US2] Add `--write-baseline` and `--baseline` modes to `scripts/lab-run.ts`, writing scorecards under `tests/fixtures/lab/baselines/` for committing (FR-038)
- [ ] T039 [US2] Make an empty evidential corpus exit non-zero with a clear message rather than reporting a comparison over test entries (FR-027d, **SC-010**)
- [ ] T040 [US2] Write the sweep in `tests/lab/sweep.test.ts` using `vi.resetModules()` + `vi.doMock` built from `vi.importActual`, so **only the swept field differs**; assert an unswept constant still holds its real value (research §6)
- [ ] T041 [US2] Read sweep definitions from `tests/fixtures/lab/sweeps/*.json` and emit one scorecard per value plus pairwise comparisons against the first, so the *shape* of the effect is visible (FR-014)
- [ ] T042 [US2] Commit one sweep definition (`WEIGHT.bye` across three values) as the worked example, so the mechanism is exercised by `npm test`
- [ ] T043 [US2] Assert in `tests/lab/sweep.test.ts` that no file under `src/engine/` is modified by a sweep run (FR-018)

**Checkpoint**: a constant change produces a reviewable diff.

---

## Phase 5: User Story 3 — Give me a corpus without waiting a year (P3)

**Goal**: import the completed drafts ESPN still serves — replayable where a board
exists, pick-sequence-only where it never did.

**Blocked by T001.** If Gate 0 showed past seasons are unavailable, T052 and the
pick-sequence-only half of this phase have no source; build the current-season
half only, and record the reduction rather than leaving tasks that cannot run.

**Independent test**: import one completed draft, confirm it matches ESPN's own
view pick for pick, carries no manager names or member identifiers, and replays
through US1 unmodified.

- [ ] T044 [US3] Write import tests in `tests/lab/import.test.ts` against a sanitized fixture: every pick captured with round, round-pick, team, player, keeper and autodraft flags; **keepers recorded for every team, not only the owner's** (FR-024); a negative D/ST id survives
- [ ] T045 [US3] Implement `scripts/lab-import.ts` using `parseCompletedDraft()` unchanged, reading through the existing credential-decryption path — no cookie in a log, a filename or an argument
- [ ] T046 [US3] Refuse a non-snake draft with a stated reason rather than importing it as though the order were a snake (FR-023)
- [ ] T047 [US3] Assign the use class in `scripts/lab-import.ts`: season covered by the pipeline → `replayable` with a snapshot matched by `chooseSetAt`; otherwise → `pick_sequence_only` with the reason naming the absent projection set (FR-020a, FR-020b)
- [ ] T048 [US3] Discard `members[]` names and member identifiers at the boundary in `scripts/lab-import.ts`, before anything is written, using `memberNamesIn()` (FR-021)
- [ ] T049 [US3] Record oracle divergence where an entry exists from both frames and ESPN — enumerate every disagreement, resolve none (FR-019f, FR-022, **SC-005**)
- [ ] T050 [US3] Add a test to `tests/lab/replay.test.ts` proving the engine **cannot** be run against a `pick_sequence_only` entry — refused structurally, not by convention (FR-020b)
- [ ] T051 [US3] Assert **provenance-agnostic replay** in `tests/lab/replay.test.ts`: two entries with identical picks, order and snapshot but different `provenance` (`live_frames` vs `espn_import`) produce identical turn observations. FR-019 requires the replay to behave the same however an entry was produced, and US3's own independent test claims it — nothing checked it
- [ ] T052 [P] [US3] Implement `src/lab/behaviour.ts` with tests in `tests/lab/behaviour.test.ts`: the distribution of (pick overall − player ADP) across pick-sequence-only entries, with ADP at or above the detected floor treated as absent (FR-020c)
- [ ] T053 [US3] Implement `scripts/lab-behaviour.ts` to report that distribution — the engine is never invoked here, these entries have no board

**Checkpoint**: the corpus grows beyond what the tap happened to catch.

---

## Phase 6: User Story 4 — Let it play the draft itself (P4)

**Goal**: the engine makes the owner's picks, modelled opponents make the rest.

**Independent test**: same seed twice ⇒ identical drafts; different seeds ⇒
bounded, reported variation.

- [ ] T054 [P] [US4] Implement mulberry32 in `src/lab/rng.ts` with tests in `tests/lab/rng.test.ts` — the only randomness in the feature, and `Math.random` stays banned by T012's guard
- [ ] T055 [US4] Implement the ADP-with-seeded-noise opponent model in `src/lab/simulate.ts`, taking `noiseSd` from T052's measured distribution rather than a chosen number. **If Gate 0 (T001) failed**, no measurement exists — use a stated placeholder and record in the output that the model is ungrounded, rather than presenting a guess as a measurement (FR-028)
- [ ] T056 [US4] Write `tests/lab/simulate.test.ts`: same seed ⇒ identical draft pick for pick; different seeds ⇒ different drafts; a player already taken is never taken again (FR-029, **SC-007**)
- [ ] T057 [US4] Report the simulated roster beside the owner's real roster from the corresponding entry, using one measure for both (FR-030)
- [ ] T058 [US4] Label every simulated result model-dependent, carrying the model identity and seed, and assert in test that it can never be merged into a shadow-replay scorecard (FR-031)
- [ ] T059 [US4] Implement `scripts/lab-simulate.ts`

---

## Phase 7: Polish & Cross-Cutting

- [ ] T060 Run a mutation sweep over `src/lab/`: corrupt each of the codec's sort, the turn-derivation, the threshold comparison, the exclusion filter and the fidelity declaration, and confirm each is killed by a **named** test. Report the count of tests that ran, not only pass/fail — 006's M7 reported SURVIVED because only 10 of 102 tests executed, and the test **count** is what caught it
- [ ] T061 [P] Verify SC-001 by timing `npm run lab:run` and recording **the corpus size alongside the figure**, plus the per-draft cost. The evidential corpus will be far short of ten drafts, so the ten-draft number is an extrapolation and must be reported as one rather than as a measurement
- [ ] T062 [P] Verify **SC-008** by emitting the Worker bundle with `wrangler deploy --dry-run --outdir <tmp>` and confirming no `src/lab/` module appears in it. **Not `npm run build`** — that is `vite build --config web/vite.config.ts`, which builds the SPA; the Worker is bundled by wrangler from `main: "src/index.ts"`, so building the SPA would prove nothing about the deployed Worker
- [ ] T063 Run `npm test` (all four projects), `npm run typecheck`, `npm run lint` and `npm run privacy` — all clean, with the privacy sweep confirming zero findings across the new fixtures
- [ ] T064 Walk [quickstart.md](quickstart.md) end to end against the built lab and correct anything that does not match what was actually built — 007's T053 was marked done in a bulk loop **without being run**, and it was the one check that would have caught a draft room that did not match its own design
- [ ] T065 Record 008 in `ROADMAP.md` as shipped, with Gate 0's result, the measured SC-001 figure and corpus size, the state of the evidential corpus, and anything the build learned that the plan did not know

---

## Dependencies

```
T001 GATE 0 ──────────────────────► blocks Phase 5 and T055's grounding
Phase 1 (Setup)
  └─► Phase 2 (Foundational) ── blocks everything
        ├─► Phase 3 US1 (P1) ── replay + admission
        │     └─► Phase 4 US2 (P2) ── needs turn observations to aggregate
        ├─► Phase 5 US3 (P3) ── independent of US2; gated by T001
        │     └─► T052 feeds T055 (the opponent model's noise)
        └─► Phase 6 US4 (P4) ── needs US1's replay; noise needs US3's T052
              └─► Phase 7 (Polish)
```

- **T001 gates Phase 5**, not the whole feature. US1 and US2 are unaffected by
  whether ESPN serves past seasons, which is exactly why the gate is cheap to run
  first and cheap to fail.
- **US2 depends on US1** and not the other way round: a scorecard aggregates turn
  observations, so there is nothing to aggregate first.
- **US3 is independent of US2.** Import can land before or after scoring.
- **US4 depends on US1** for the engine call and on **T052** for its noise
  parameter. Built with a placeholder it is still reproducible but not grounded,
  and T055 requires that be said in the output.
- **T025 depends on T023/T024 existing** (it asserts against their SQL) but is
  listed in Phase 3 rather than Polish so the additive property is proven while
  the admitting code is being written, not after.
- **T031** (re-admitting existing drafts as test runs) can happen any time after
  T030 and should happen early: until it does, the corpus holds entries whose
  provenance class is undeclared.

## Parallel opportunities

Every `[P]` is a genuinely distinct file. Where two tasks extend the same file
they are sequential by design.

- **Phase 1**: T003 and T004 touch different files. T001 and T002 are not marked
  — T001 gates and T002 must land before any test runs.
- **Phase 2**: T008, T010, T012 and T013 are four separate test files. T006 is
  not marked — T007 implements against it.
- **Phase 3**: T018 is the only marked task; the rest share `replay.test.ts`,
  `replay.ts` or `lab-admit.ts`. **T025 is unmarked despite being in
  `boundary.test.ts`**, because T012 already writes that file.
- **Phase 4**: T036 (`compare.test.ts`) is independent of T032's
  `scorecard.test.ts`. The sweep tasks share one file and stay sequential.
- **Phase 5**: T052 is a different file from the import work. T050 and T051 both
  extend `replay.test.ts` and are sequential.
- **Phase 6**: T054 is independent; the rest share `simulate.ts` / its test.
- **Phase 7**: T061 and T062 are independent measurements; T060, T063 and T064
  each run or mutate the whole suite and must not race.

## Implementation strategy

**MVP is Phase 1 → Phase 2 → Phase 3.** That delivers the thing nobody can do
today: look at the engine's judgement across a whole real draft, turn by turn,
with reasons. Phase 4 is what the constitution actually requires, and it is
short once Phase 3 exists.

Phases 5 and 6 are genuinely optional increments. **If time runs short, drop
Phase 6.** US4 is the most machinery for the least certain output, and nothing in
US1–US3 depends on it.

**Run T001 before anything else, including Phase 2.** It costs one authenticated
read and it decides whether a third of Phase 5 exists.

## The six traps in this feature

1. **Snapshotting the engine's output instead of its input.** The snapshot is an
   `EngineBundle` — board, signals, roster shape, preferred list. If the *ranked
   board* were stored instead, every replay would return August's answer forever
   no matter what the rules say, which inverts the entire feature. T009 and T020.

2. **A second frame decoder.** The temptation is to parse relay payloads directly
   in the admitting script rather than routing through `foldBatches()` and
   `reconcile()`. 010's oracle caught a wrong reading of `SELECTED`'s third field
   that agreed with the truth on **5 of 70 picks** — a second decoder is a second
   chance to make that mistake with nothing to catch it. T023.

3. **A quality score that is quietly circular.** The engine ranks by projected
   points, so *any* aggregate built from projected points rewards changes that
   increase agreement with the engine's own input. It will look like a clean
   improvement metric and it will steer every tuning session wrong. T033 and T035
   exist to keep the outcome slot **empty** rather than let something plausible
   fill it.

4. **Filtering on the sign of a player id.** D/ST ids sit near −16000 and `−1` is
   the empty-slot sentinel. `playerId > 0` is what made 010's capture report 66 of
   72 picks for a complete draft. T006 asserts both cases explicitly.

5. **A determinism test that cannot fail.** The most dangerous outcome here,
   because it arrives with a green tick. Comparing a run to itself, or hashing
   after rounding the difference away, passes against any implementation. T019
   requires a companion assertion proving the check **can** fail — 007 shipped an
   SC-003 assertion that pushed a hardcoded `0` and then asserted it was under
   2000, and it would have passed against nothing at all.

6. **Admitting a test draft as real.** A single mock in the corpus silently
   contaminates every comparison afterwards, and nothing downstream can detect
   it — a mock draft replays perfectly. T030 makes `--class` required with no
   default for exactly this reason, and T031 classifies the existing captures
   before they can be mistaken for evidence.
