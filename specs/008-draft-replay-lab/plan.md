# Implementation Plan: Draft Replay Lab

**Branch**: `008-draft-replay-lab` | **Date**: 2026-08-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-draft-replay-lab/spec.md`

## Summary

Build the instrument that makes 006's twelve unscored tuning constants
defensible: replay real, completed drafts against the engine offline, turn by
turn, and compare rule sets over a corpus with a committed baseline.

The technical approach follows from one observation — **the engine's input
shapes already split exactly along the line a replay needs.** `EngineBundle` is
the slow half and `EngineState` the fast half, so a corpus entry's input
snapshot is simply a serialized `EngineBundle`, and the replay calls
`recommend(bundle, state)` — the same function production calls. That makes
FR-002 ("invoke the engine unmodified") structural rather than aspirational:
there is no adapter to drift and no second assembly path to keep in step.

Three findings during clarify reshaped the design and are load-bearing here:

1. **The corpus decays unless snapshotted.** `pruneSets()` deletes prior-season
   projection sets on every maintenance pass, and `signal_entries` is
   overwritten in place. Snapshotting at admission makes an entry immune to both,
   additively — 002 and 004 keep their shipped behaviour.
2. **The archive path cannot be the source.** Zero rows in production, gated on
   unfinished 005 work. Entries are built by folding retained relay batches
   through the existing pure `foldBatches()` → `reconcile()` pipeline instead.
3. **The captured drafts are test runs.** Retained as harness fixtures, excluded
   from every rule-set comparison. The evidential corpus is empty today.

**No database schema, no endpoint, no page, no new dependency.**

## Technical Context

**Language/Version**: TypeScript 5.7, ES2022 modules

**Primary Dependencies**: none added. Reuses `src/engine/*` (the subject under
test), `src/draft/{feed,reconcile,snake}.ts` (pure, verified: no D1, no `Env`, no
`fetch`, no `Date.now`), `src/espn/parsers.ts` (`parseCompletedDraft`),
`src/projections/scoring.ts` (`buildLeagueBoard`), and
`scripts/sanitize-espn.ts` (`memberNamesIn`) for screening.

**Storage**: committed JSON fixtures under `tests/fixtures/lab/`. **No
migration.** D1 and ESPN are read at *admission* only, never during a run.

**Testing**: vitest 3.2, new `lab` project (node environment) in
`vitest.config.ts`, joined to `npm test`. Fixtures load via
`import.meta.glob(..., '?raw')` — no `node:fs` in tests, since `tests/lab/**`
stays inside the root tsconfig, which carries no node types.

**Target Platform**: developer machine (node via `tsx`) and CI. **Never the
deployed Worker.**

**Project Type**: offline analysis harness — pure core plus thin I/O scripts,
the same shape as 005's reconciler, 006's engine and 007's room reducer.

**Performance Goals**: SC-001's five minutes for ten drafts is a **ceiling, not
a target**. The real work is ~120 `recommend()` calls over ~500 players;
snapshot deserialization dominates. Seconds, not minutes.

**Constraints**: deterministic to the byte (FR-009, FR-013, SC-002) — canonical
serialization, seeded PRNG, no clock in the core. Nothing written under
`src/engine/` (FR-018). Nothing reachable from a live-draft flow (FR-032/035).

**Scale/Scope**: ~10 drafts × ~12 owner turns; ~100–250 KB snapshot per draft.
Today the evidential corpus is **empty** — the first entry arrives with the first
real 2026 league draft.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design — see below.*

| Principle | Assessment |
|---|---|
| **I. Spec-First** | ✅ spec + clarify complete (5 questions, `959f5ea`) before any code. |
| **II. Any-League** | ✅ every league-specific value comes from the corpus entry and its snapshot. No league id, team id or credential in lab code; fixtures carry ids as *data*. |
| **III. League Currency** | ✅ **inherited structurally.** The snapshot is an `EngineBundle`, whose board is already scored in the league's own rules — a replay cannot accidentally score in generic PPR. Cross-league comparison uses `gapInRounds`, denominated in `ROUND_VALUE`. |
| **IV. Rules Are Code** | ✅ and actively defended. FR-018 forbids writing to constants; the sweep substitutes the *module* in-process (research §6) rather than introducing a config seam. Nothing the lab adds is reachable from an endpoint, column or page. |
| **V. Draft Day Is Unforgiving** | ✅ the lab adds nothing to the live path, asserted by a structural import guard rather than promised. It also *serves* this principle: it is what lets a rule change be validated before draft day rather than discovered during one. |
| **VI. Recommend, Never Act** | ✅ import is a read of ESPN's post-completion view. No draft-room connection, no `JOIN`, no write. |
| **VII. Explainable** | ✅ `TurnObservation` carries 006's full `Recommendation` with explanations; `decisiveRule` is derived from the engine's own output, not recomputed. |
| **VIII. Simplicity** | ✅ no new dependency, no schema, no runtime surface, no third tsconfig. Reuses the reconciler, parser and engine as-is. See the note below on US4. |

**Security & Privacy**

- ESPN credentials: read by `lab:import` through the existing decryption path;
  never logged, never written to a fixture, never in a filename or argument.
- Fixture sanitization: screened **at admission, before the write** (FR-021), not
  by post-hoc sweep. The sweep is the backstop. `privacy-sweep.ts` already walks
  `tests/fixtures`, so lab fixtures are covered from the first commit — verified
  by reading its ROOTS array, not assumed.
- Screening reuses `memberNamesIn()` rather than reimplementing it. The comment in
  `privacy-sweep.ts` records why: its first version had its own copy of the
  matching logic, the copy was wrong, and real member names shipped to a public
  repo while it printed "clean".
- Per-user isolation (FR-027): the admitting query is scoped by `account_id` in
  the query itself, matching `tap_batches` and `preferred_players`.

**Technical Constraints**: no new browser artifact; the tap remains the only one.
No native app. Hosting unchanged — nothing deploys.

**Result: PASS, no violations.** Complexity Tracking is empty.

One item worth naming rather than hiding: **US4 (simulation) is the most
machinery for the least certain output**, and Principle VIII invites scrutiny. It
survives because ROADMAP names it, the spec scopes it, and it is P4 — US1–US3
deliver the constitution's actual requirement and US4 can be dropped without
touching them. Its findings are labelled model-dependent precisely so they cannot
quietly acquire the standing of a shadow replay.

## Project Structure

### Documentation (this feature)

```text
specs/008-draft-replay-lab/
├── plan.md              # This file
├── research.md          # Phase 0 — 11 sections, 3 code-verified contradictions
├── data-model.md        # Phase 1 — file formats and in-memory shapes
├── quickstart.md        # Phase 1 — how to prove it works and how to use it
├── contracts/
│   ├── cli.md           # the lab's only interface
│   └── corpus.md        # the cross-time fixture contract
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks output — NOT created here
```

### Source Code (repository root)

```text
src/lab/                        # PURE core. Nothing outside this dir imports it.
├── corpus.ts                   # entry + snapshot types, invariant checks
├── codec.ts                    # bundle <-> snapshot, canonical + sorted
├── setChoice.ts                # chooseSetAt(rows, at) — which set was serving
├── replay.ts                   # shadow replay -> TurnObservation[]
├── scorecard.ts                # aggregate + RuleSetIdentity
├── compare.ts                  # two scorecards -> Comparison
├── behaviour.ts                # pick-vs-ADP distribution (FR-020c)
├── simulate.ts                 # seeded opponent model + simulated draft
└── rng.ts                      # mulberry32; the only randomness in the feature

scripts/                        # I/O. Outside the root tsconfig, so node:fs is fine.
├── lab-admit.ts                # retained frames -> screened fixture + snapshot
├── lab-import.ts               # ESPN completed draft -> screened fixture
├── lab-run.ts                  # replay corpus -> scorecard / comparison
├── lab-behaviour.ts
└── lab-simulate.ts

tests/lab/                      # node project; inside the root tsconfig
├── codec.test.ts
├── setchoice.test.ts
├── replay.test.ts
├── scorecard.test.ts
├── compare.test.ts
├── corpus.test.ts              # invariant enforcement, incl. negative playerIds
├── durability.test.ts          # SC-009 — replay survives source deletion
├── sweep.test.ts               # FR-014 via module substitution
├── simulate.test.ts
└── boundary.test.ts            # structural: FR-035, no clock/RNG in the core

tests/fixtures/lab/
├── <league>-<season>.draft.json
├── <league>-<season>.inputs.json
├── baselines/*.scorecard.json
└── sweeps/*.json
```

**Structure Decision**: pure core in `src/lab/`, beside `src/engine/` and
`src/draft/`, so imports resolve without cross-tree paths or a third tsconfig.
`tap/` is top-level only because it targets the browser and its DOM globals
conflict with workers-types; the lab has no such conflict, so a separate tree
would be complexity for its own sake.

Nothing under `src/lab/` is reachable from `src/index.ts`, so it is never
bundled into the Worker. That is enforced by `boundary.test.ts` reading the
import graph — the same technique 006 used for FR-010/FR-011, and the lesson 005
paid for when `writeArchive` was built, tested and never called.

**Consequence to respect while implementing**: `tests/lab/**` stays inside the
root tsconfig (it imports `src/engine` and `src/draft`, exactly as
`tests/engine` and `tests/draft` do), which has no node types — so **no
`node:fs` in the core or its tests**. Fixtures load via the literal
`import.meta.glob(..., '?raw')` form, which Vite rewrites at build time and which
cannot be aliased or factored into a helper.

## Phase Sequencing

Phases map to the spec's user-story priorities; each lands independently.

| Phase | Delivers | Spec |
|---|---|---|
| **1 — Foundations** | corpus types, codec, invariants, `chooseSetAt`, boundary + determinism guards | FR-019a–d, FR-025–027d, FR-035 |
| **2 — Replay (US1)** | `replay.ts`, turn observations, `lab-run.ts` single-entry mode | FR-001–009, SC-004 |
| **3 — Admission** | `lab-admit.ts` (frames), screening, snapshot capture, SC-009 durability test | FR-019e–g, FR-021, SC-009 |
| **4 — Scoring (US2)** | scorecard, comparison, baselines, sweep | FR-010–018, FR-038, SC-001/002 |
| **5 — Import (US3)** | `lab-import.ts`, use classes, oracle divergence, behaviour report | FR-020–024, FR-020a–c, SC-005 |
| **6 — Simulation (US4)** | seeded PRNG, opponent model, simulated draft | FR-028–031, SC-007 |

Phase 1 is genuinely foundational — replay, scoring and import all need the codec
and the invariants. Phases 4, 5 and 6 are independent of each other.

## Post-Design Constitution Re-check

Re-evaluated against the artifacts now that the design exists:

| Risk surfaced by the design | Verdict |
|---|---|
| Snapshot stores an `EngineBundle` — does that freeze *rules* as well as inputs? | **No.** The bundle is input only; the ranked board is the engine's output and is deliberately not stored (research §1). A replay under new constants genuinely re-ranks. Had the output been snapshotted, every replay would have returned August's answer forever — the exact opposite of the feature's purpose. |
| Module substitution for sweeps — a config seam by the back door? | **No.** Nothing in the engine reads it, nothing persists, and the substitution exists only inside a test process. The engine's own source is unchanged, which is what Principle IV protects. |
| `src/lab/` inside the Worker's source tree | Acceptable and guarded. Never imported by `src/index.ts`; `boundary.test.ts` asserts it structurally rather than trusting the bundler. |
| Committed corpus contains other managers' picks | Permitted and already precedented — numeric identifiers only, screened at admission, and `tests/fixtures/tap/replay-full.jsonl` is a real draft already in this repo under the same rules. |
| US4's opponent model could be tuned to flatter the engine | Mitigated: `noiseSd` is characterised from real pick-vs-ADP data (FR-020c), the seed is recorded, and every simulated finding is labelled model-dependent (FR-031). |

**Result: PASS.** No violations, no justifications required, Complexity Tracking
remains empty.
