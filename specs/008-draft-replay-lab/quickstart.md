# Quickstart: Draft Replay Lab

**Feature**: 008-draft-replay-lab

How to prove the lab works, and how to actually use it for the thing it exists
for: deciding whether a change to a tuning constant made the engine better or
worse.

---

## Prerequisites

- `npm ci` (no new dependencies — the lab adds none)
- For admission only: `wrangler` authenticated against the **icloud.com**
  account, and ESPN credentials already stored for the league
- For runs: nothing. Runs read committed fixtures and work offline (FR-036)

---

## 0. Gate 0 — the one thing to settle first

```bash
ESPN_S2='...' SWID='{...}' npx tsx scripts/lab-gate0.ts --league <espnLeagueId> --season 2024
```

**Run this before Phase 5 (import) is used in anger.** It asks whether ESPN still
serves a completed draft for a *past* season. 005's Gate 0 proved ESPN writes the
completed draft reliably — but for the **current** season, on a draft that had
just finished. Nothing has ever asked a two-year-old league.

It probes **both** URL forms, because ESPN serves prior seasons from
`/leagueHistory/{id}?seasonId=` (returning an array) rather than the
`/seasons/{y}/segments/0/leagues/{id}` path `src/espn/client.ts` uses. Probing
only one would make "ESPN has no past drafts" and "we asked the wrong way"
produce the same answer, and those have opposite consequences.

Prints a summary only — no fixture written, no cookie in a URL, a log line or an
error. A **FAIL** verdict prints exactly what shrinks.

**Already run, 2026-08-05: PASS.** A 2025 league returned 140 filled picks, zero
skeleton rows and a present draft order, identically by both URL forms. So
`pick_sequence_only` has a real source, and `src/espn/client.ts` needs no second
URL shape. Full result in [research.md](research.md) §12 — no need to re-run it
unless ESPN changes.

---

## 1. The correctness suite

```bash
npm test
```

Covers `tests/lab/**` alongside everything else. What to look for:

| Check | Proves |
|---|---|
| Replay produces a ranked board at every owner turn | FR-001 – FR-004, SC-004 |
| A drafted player absent from the board is *stated*, and the turn still resolves | FR-005 |
| Owner turns derive from round + order, never a pick field | FR-006 |
| Codec round-trips a bundle byte-identically | canonical serialization |
| Same corpus twice ⇒ identical hash | FR-009, SC-002 |
| Identical rule sets ⇒ empty comparison | FR-013 |
| Snapshot replays identically after the source set is deleted | FR-019b, **SC-009** |
| Test-run entries appear in `excluded[]`, never in `behavioural` | FR-027b, SC-010 |
| Nothing outside `src/lab/` imports `src/lab/` | FR-035, SC-008 |
| No `Math.random` / `Date.now` in the lab core | research §7 |

The privacy sweep runs as the third step of `npm test` and already walks
`tests/fixtures`, so lab fixtures are covered from the first commit.

**The one that matters most is SC-009** ([durability.test.ts](../../tests/lab/durability.test.ts)).
"The source set was deleted" cannot be staged, because the whole point of the
design is that no live table is ever consulted — so durability is proven the way
it is actually guaranteed: structurally (`replayEntry` takes an entry and a
bundle, and imports nothing from `src/db/`) and behaviourally (a snapshot
round-tripped through *text* replays identically). It is the only assertion that
would have caught `pruneSets()` quietly emptying the corpus in January.

**Measured on this build**: 178 lab tests, 989 + 80 across the whole suite.

### The mutation sweep

```bash
# Corrupt one thing, confirm a NAMED test dies, revert with an inverse edit.
# Never `git checkout` a file with uncommitted work — that silently reverted
# real code twice during 005.
```

Six mutations, all killed, with the full 178 running each time — 006's M7
reported SURVIVED only because 10 of 102 tests actually executed, so the test
**count** is checked, not just pass/fail.

| Mutation | Killed by |
|---|---|
| codec drops its sort | 1 test — byte-identity from two input orderings |
| turn read from the pick's `teamId` | **survived at first** — see below |
| off-by-one: state includes the pick being made | 4 tests |
| threshold comparison inverted | 2 tests |
| exclusion filter drops the provenance half | 3 tests |
| fidelity always claims `as_of` | 1 test |

The survivor was real. `replayEntry` passed `observed` — built from each pick's
own `teamId` — into `teamAt`, which prefers observation over projection. So the
turn was *effectively* derived from the field FR-006 says never to read, and no
fixture could tell, because every fixture is internally consistent. The code was
changed (not the test): the schedule now comes from an empty-observation
projection, and a disagreement between it and the recorded `teamId` is **raised
as a fault** rather than silently resolved — the discipline 010 applied to its
oracle.

---

## 2. Admit a draft

Pick a real, completed draft. Classification is required and has no default —
misclassifying a mock as real is the failure this guards against.

```bash
npx tsx scripts/lab-admit.ts --league <espnLeagueId> --season 2026 --class real
```

Expect: a `.draft.json` and a `.inputs.json` under `tests/fixtures/lab/`, and a
printed fidelity line. For a draft admitted after the fact, `signals` will read
`present_day` — correct, and permanent for that entry.

Re-admitting the drafts captured so far uses `--class test`. They stay in the
corpus as harness fixtures and are excluded from every comparison (FR-027c).

```bash
npx tsx scripts/lab-import.ts --league <espnLeagueId> --season 2024 --class real
```

Expect: `useClass: pick_sequence_only`, with the reason naming the absent
projection set. This is correct, not a failure — a 2024 board does not exist and
cannot be fetched.

---

## 3. Look at one draft, turn by turn (US1)

```bash
npx tsx scripts/lab-run.ts --entry <id>
```

Per owner turn: the engine's first choice with reasoning, the player actually
taken, that player's rank in the engine's ordering, and the gap **in rounds** —
the unit that means the same thing in a 10-team standard league and a 14-team PPR
one.

With an empty evidential corpus this exits non-zero and says so. That is
FR-027d working: today the evidential corpus *is* empty, and a comparison over
test runs would be worse than no comparison.

---

## 4. Score a rule change (US2) — the actual workflow

```bash
# 1. Record where you are
npx tsx scripts/lab-run.ts --write-baseline tests/fixtures/lab/baselines/current.scorecard.json

# 2. Change one number in src/engine/constants.ts

# 3. See what it did
npx tsx scripts/lab-run.ts --baseline tests/fixtures/lab/baselines/current.scorecard.json
```

The comparison names every turn whose shortlist head changed and every ordering
movement beyond the stated threshold — and **states the threshold**, so an
unchanged turn is distinguishable from one that moved below the bar.

Commit the constants change and the new baseline together. That is what makes
"validated against replays before draft day" a review gate rather than a habit.

**If step 3 reports a non-empty diff after changing nothing, that is a
determinism failure, not a rule effect** — it is labelled as such, and every
comparison is worthless until it is fixed.

**What you will not get**: a single number saying the change was an improvement.
The engine ranks by projected points, so any projection-derived quality score
rewards agreement with the engine's own input — which is precisely what the rule
layer exists to correct. Outcome measures based on actual season points are
reserved in the scorecard and print as explicitly empty until a season has been
played (FR-017a).

---

## 5. Sweep a constant (US2 / FR-014)

Commit a definition:

```json
{ "name": "bye-weight", "constantPath": "WEIGHT.bye", "values": [0.2, 0.35, 0.5] }
```

```bash
npm run lab:sweep
```

One result per value, so the *shape* of the effect is visible rather than a
single before/after pair. The definition is a committed artifact, so the sweep
that produced a finding sits in the diff alongside it.
[`sweeps/bye-weight.json`](../../tests/fixtures/lab/sweeps/bye-weight.json) is
the worked example and runs under `npm test`.

Nothing is written to `src/engine/` at any point — values are substituted in
memory with `vi.resetModules()` + `vi.doMock` built from `vi.importActual`, so
only the swept field differs and every other constant provably comes from the
real module. Both properties are asserted, and the FR-018 check compares the
engine's constants before and after a sweep rather than trusting the mechanism.

---

## 6. Ground the opponent model (FR-020c)

```bash
npx tsx scripts/lab-behaviour.ts
```

Reports the distribution of (pick overall − player ADP) across pick-sequence-only
entries. This is what sets the simulation's noise from data rather than taste,
and it is the one job those unreplayable imports exist to do.

---

## 7. Simulate (US4)

```bash
npx tsx scripts/lab-simulate.ts --entry <id> --seed 42
npx tsx scripts/lab-simulate.ts --entry <id> --seed 42   # identical, pick for pick
```

Output carries the model identity and the seed, and is labelled
**model-dependent**. It is not filed beside a shadow replay as equal evidence:
the moment the engine takes a different player, every real pick after it becomes
counterfactual, and the result is only as good as the opponent model.

---

## Troubleshooting

## Measured on this build

| | |
|---|---|
| `lab:run` wall clock | **0.65–0.68 s**, indistinguishable at 0, 1 or 3 entries — the tsx process start dominates entirely, and the replay work is below measurement noise |
| corpus it was measured on | 1 synthetic entry: **18 picks, 24 players, 3 owner turns** |
| SC-001's bar | 5 minutes for ten drafts |

**The ten-draft figure is an extrapolation, not a measurement, and must be
re-measured once a real entry exists.** A real board is ~522 players against 24,
and a real draft ~15 owner turns against 3 — roughly 110× the engine work per
draft. Even so the ceiling is three orders of magnitude away, and the shape of
the cost (per-turn `recommend()` over the board) is understood rather than
guessed.

| Symptom | Cause |
|---|---|
| `lab:run` exits: "no admissible entries" | Corpus is all test runs or pick-sequence-only. **Expected today** — the only committed entry is synthetic and classed `test`. |
| `refusing to write: corpus contains an identifier` | Screening caught a GUID or URL. Working as intended — do not bypass it. |
| Entry admitted as `pick_sequence_only` unexpectedly | No complete projection set predates the draft, or `gaps` is non-empty. The reason is in `unreplayableReason`. |
| Comparison non-empty after no rule change | Determinism failure. `lab:run` exits non-zero and says so rather than printing movement. Check for unsorted iteration in the codec first. |
| `import.meta.glob` returns `{}`, or the build fails with "Expected the second argument to be an object literal" | The options object was hoisted into a `const`. Vite only rewrites the **literal** call — this bit during the build of this very feature. |
| `replayEntry` throws "the round and order put team N on the clock" | The entry's picks disagree with its own schedule. Raised as a fault, never resolved — the corpus entry is not trustworthy. |
| Two tap typecheck errors in `tap/main.ts` / `tests/tap/corpus.test.ts` | **Pre-existing**, reproduced at `31abebf` before any 008 code. Not this feature's. |
