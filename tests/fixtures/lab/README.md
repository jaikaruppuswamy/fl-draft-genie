# Lab corpus fixtures (008)

The replay lab's corpus. Full contract:
[`specs/008-draft-replay-lab/contracts/corpus.md`](../../../specs/008-draft-replay-lab/contracts/corpus.md).

**These files are a cross-time contract.** One written today must still be
readable in 2028 — that is the entire reason the snapshot exists. The
maintenance cron deletes prior-season projection sets outright, and signal
values are overwritten in place with no history, so an entry that merely
*pointed* at those tables would quietly stop being replayable.

## Layout

```
<espnLeagueId>-<season>.draft.json     CorpusEntry — picks, shape, classes
<espnLeagueId>-<season>.inputs.json    InputSnapshot — the engine's slow half
baselines/<name>.scorecard.json        committed baselines for rule comparison
sweeps/<name>.json                     sweep definitions
```

Entry and snapshot are separate files on purpose: the entry is small and
readable in a diff, the snapshot is a few hundred KB of board data nobody reads
by eye. Together, every review would scroll past 500 players to find that a
keeper flag changed.

## Two classes, and they are orthogonal

| | meaning |
|---|---|
| `useClass: replayable` | carries an input snapshot; the engine can run on it |
| `useClass: pick_sequence_only` | no board ever existed for that season; engine never runs |
| `provenanceClass: real` | a real league draft |
| `provenanceClass: test` | a mock or rehearsal |

**Only entries that are both `replayable` and `real` are evidence.** A test
draft replays perfectly and is still inadmissible — a mock room does not draft
the way a real one does, so tuning against one fits noise. Test entries are kept
rather than deleted: they are the only proof the reconciler and replay path work
against real relay frames.

## Never in these files

Backstopped by `scripts/privacy-sweep.ts`, which already walks `tests/fixtures`.
The sweep is the backstop, **not the gate** — screening happens at admission,
before the write.

- ESPN cookies (`espn_s2`, `SWID`)
- Member GUIDs (a SWID by another name)
- Manager names, team names, free text
- URLs (they carry ids and tokens in query strings)

Player names **are** permitted: public NFL rosters, already present in
`tests/fixtures/espn/kona-players.json`, and a board without them is unreadable
in a diff.

## Canonical form

Object keys sorted, arrays sorted by natural key, numbers rounded at the
boundary (4dp in scorecards), two-space indent, trailing newline.

**No timestamps of convenience.** Nothing records when a file was written. A
field that changes on every regeneration makes every diff noisy and hides the
one line that mattered.

## Versioning

Every file carries `formatVersion`. A reader meeting an unknown version **fails
loudly** — it must not guess, coerce, or fall back. Adding an optional field is
minor; removing or re-meaning one bumps the version and regenerates existing
fixtures in the same commit.

The failure this prevents is silent: an old snapshot read under new assumptions
produces plausible numbers from misinterpreted data, and nothing would flag it.
