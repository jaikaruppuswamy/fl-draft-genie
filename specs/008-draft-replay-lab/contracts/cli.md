# Contract: Lab Commands

**Feature**: 008-draft-replay-lab

The lab's only interface. There is no endpoint and no page (FR-035) — these
commands, plus the fixtures they read and write, are the whole surface.

Two invocation styles, and the split is not arbitrary:

- **`tsx scripts/lab-*.ts`** for anything touching the filesystem, D1 or ESPN.
  Scripts sit outside the root tsconfig `include`, so they may use `node:fs`
  freely — the same arrangement `scripts/export-tap-corpus.ts` already uses.
- **`vitest`** for the sweep, which needs per-value module substitution
  (research §6). Nothing else needs it.

---

## `npm run lab:admit` — admit a live-observed draft

```bash
npx tsx scripts/lab-admit.ts --league <espnLeagueId> --season 2026 \
  [--class real|test] [--local] [--out tests/fixtures/lab/]
```

Reads retained relay batches for that league and season, folds them through
`foldBatches()` → `reconcile()`, snapshots the engine inputs, screens, writes.

| Step | Behaviour |
|---|---|
| Read | `tap_batches`, **scoped by account** (FR-027), via wrangler — same pattern as `export-tap-corpus.ts`. |
| Reconcile | Existing pure pipeline. No second decoder (research §2). |
| Gaps | Missing overall numbers recorded in `gaps`; non-empty ⇒ `useClass: pick_sequence_only` (FR-019g). |
| Snapshot | `chooseSetAt(sets, startedAt)`; **no set predating the draft ⇒ refuse to snapshot** and mark unreplayable (FR-019d). |
| Fidelity | `signals: "present_day"` unless admitted during the draft — stated, never implied. |
| Screen | GUID / URL / member-name check via `memberNamesIn()` before any write (research §9). |
| Class | `--class` is **required**; there is no default. Misclassifying a mock as real is the failure mode, so the tool asks rather than guesses. |

Exit non-zero without writing if screening fails.

---

## `npm run lab:import` — import a completed ESPN draft

```bash
npx tsx scripts/lab-import.ts --league <espnLeagueId> --season <year> \
  [--class real|test] [--out tests/fixtures/lab/]
```

| Step | Behaviour |
|---|---|
| Fetch | ESPN's completed-draft view — a read, no draft-room connection (FR-033, Constitution VI). |
| Parse | `parseCompletedDraft()` unchanged. No sign filter on `playerId`. |
| Format | Non-snake ⇒ refuse with a stated reason (FR-023). |
| Use class | Season covered by the pipeline ⇒ `replayable` + snapshot (FR-020a). Otherwise ⇒ `pick_sequence_only` with the reason (FR-020b). |
| Keepers | Recorded for **every** team (FR-024). |
| Screen | The authenticated response carries `members[]` with real names and SWIDs. Discarded before anything is written (FR-021). |
| Oracle | Where the entry also exists from frames, the two are compared and divergences recorded, never resolved (FR-019f, FR-022). |

---

## `npm run lab:run` — replay the corpus and score it

```bash
npx tsx scripts/lab-run.ts [--baseline <path>] [--write-baseline <path>] \
  [--entry <id>] [--json]
```

**The command SC-001 is measured on.** Replays every admissible entry under the
constants currently in `src/engine/constants.ts`, prints a scorecard, and — with
`--baseline` — a comparison.

| Behaviour | Detail |
|---|---|
| Admissible | `useClass: replayable` **and** `provenanceClass: real` (FR-027b). |
| Excluded | Named in `excluded[]` with a reason. Never silently dropped. |
| Empty corpus | Says so and exits non-zero rather than reporting a comparison over nothing (FR-027d, SC-010). |
| Fidelity | Printed per entry, always (FR-015). |
| Determinism | Output is canonical; identical rule sets ⇒ empty comparison, and a non-empty one is reported as a **determinism failure**, not a rule effect (FR-013). |
| Outcome | The outcome block prints as explicitly empty until the season is played (FR-017a). Never omitted, never filled with a projection-derived stand-in. |

`--write-baseline` writes a scorecard for committing (FR-038). It never writes
anything under `src/engine/` (FR-018).

---

## `npm run lab:sweep` — one constant, many values

```bash
npx vitest run --project lab tests/lab/sweep.test.ts
```

Runs every committed definition in `tests/fixtures/lab/sweeps/*.json`, producing
one scorecard per value plus pairwise comparisons against the first.

Module substitution per value (research §6): `vi.resetModules()`, then
`vi.doMock` built from `vi.importActual` so **only the swept field differs**.
Nothing is written to the engine, and a crashed run leaves no residue.

Adding a sweep means committing a definition file — so the sweep that produced a
finding is itself in the diff.

---

## `npm run lab:behaviour` — characterise real drafters against ADP

```bash
npx tsx scripts/lab-behaviour.ts
```

**FR-020c.** Reads `pick_sequence_only` entries and reports the distribution of
(pick overall − player ADP), which is what sets `OpponentModel.noiseSd` from data
rather than taste. The engine is never invoked here — these entries have no board.

---

## `npm run lab:simulate` — US4

```bash
npx tsx scripts/lab-simulate.ts --entry <id> --seed <n> [--runs <n>]
```

Owner picks from the engine, everyone else from the opponent model. Same seed ⇒
identical draft, pick for pick (FR-029). Output carries the model identity and
seed, and is labelled **model-dependent** (FR-031).

---

## Guarantees across all commands

1. **No live-draft effect.** Nothing here is reachable from a draft-day flow
   (FR-032), asserted structurally rather than promised (research §8).
2. **Read-only against ESPN** (FR-033). No draft-room connection, ever.
3. **No writes to `src/engine/`** (FR-018).
4. **Runs read committed fixtures only** (FR-036). `lab:admit` / `lab:import` are
   the *only* commands that touch D1 or ESPN, and they are admission, not runs.
5. **Nothing written without screening** (FR-021, FR-034).
