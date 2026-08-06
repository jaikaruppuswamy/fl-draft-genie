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

**The one that matters most is SC-009.** It deletes the projection set a snapshot
came from and replays again, expecting identical output. That is the assertion
that the corpus has no shelf life — and the only one that would have caught
`pruneSets()` quietly emptying the corpus in January.

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
npx vitest run --project lab tests/lab/sweep.test.ts
```

One scorecard per value plus pairwise comparisons against the first, so the
*shape* of the effect is visible rather than a single before/after pair. The
definition is a committed artifact, so the sweep that produced a finding is in
the diff alongside it.

Nothing is written to `src/engine/` at any point — values are substituted by
swapping the module in-process (research §6).

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

| Symptom | Cause |
|---|---|
| `lab:run` exits: "no admissible entries" | Corpus is all test runs or pick-sequence-only. Expected today. |
| `refusing to write: corpus contains an identifier` | Screening caught a GUID or URL. Working as intended — do not bypass it. |
| Entry admitted as `pick_sequence_only` unexpectedly | No complete projection set predates the draft, or `gaps` is non-empty. The reason is in `unreplayableReason`. |
| Comparison non-empty after no rule change | Determinism failure. Check for unsorted iteration in the codec first. |
| `import.meta.glob` returns `{}` in a test | It was aliased or factored into a helper. Vite only rewrites the literal call. |
