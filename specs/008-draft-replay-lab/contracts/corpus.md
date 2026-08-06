# Contract: Corpus Fixture Format

**Feature**: 008-draft-replay-lab

This is a **cross-time contract**, which makes it the most consequential file in
the feature. A fixture written today must be readable in 2028, because that is
the entire reason the snapshot exists (research §3). Shapes are defined in
[data-model.md](../data-model.md); this file governs how they are written, read
and evolved.

---

## Layout

```text
tests/fixtures/lab/
├── <espnLeagueId>-<season>.draft.json     # CorpusEntry
├── <espnLeagueId>-<season>.inputs.json    # InputSnapshot (replayable entries only)
├── baselines/<name>.scorecard.json        # committed baselines (FR-038)
└── sweeps/<name>.json                     # SweepDefinition
```

The entry and its snapshot are separate files on purpose: the entry is small and
readable in a diff, the snapshot is a few hundred KB of board data that nobody
reads by eye. Putting them together would make every review scroll past 500
players to see that a keeper flag changed.

---

## Canonical serialization

Non-negotiable, because FR-009, FR-013 and SC-002 all reduce to "the same input
produces the same bytes".

1. **Object keys sorted** ascending, at every level.
2. **Arrays sorted** by their natural key — picks by `overall`, players by
   `espn_player_id`, signals by `(kind, proTeamId)`, `preferred` ascending. A
   snapshot built from two different query orderings must be byte-identical.
3. **Numbers rounded at the boundary**: 4 decimal places in scorecards and
   comparisons. Board values keep the engine's own rounding — the lab does not
   re-round what 006 produced.
4. **Two-space indent, trailing newline.** These files are reviewed as diffs.
5. **No timestamps of convenience.** Nothing records "when this file was
   written". A field that changes on every regeneration makes every diff noisy
   and hides the one line that mattered.

---

## Versioning

Every file carries `formatVersion`.

- A reader encountering an **unknown** version **MUST fail loudly**. It must not
  guess, coerce, or fall back to a default shape.
- Adding an optional field is a minor change and does not bump the version.
- Removing or re-meaning a field bumps it, and existing fixtures are regenerated
  in the same commit.

The rule exists because the failure it prevents is silent: an old snapshot read
under new assumptions produces plausible numbers from misinterpreted data, and
nothing anywhere would flag it.

---

## What may never appear in a fixture

Enforced by `scripts/privacy-sweep.ts`, which already walks `tests/fixtures` —
so files here are covered by `npm test` from the first commit, with no change to
its ROOTS list.

| Forbidden | Why |
|---|---|
| ESPN cookies (`espn_s2`, `SWID`) | Constitution — secrets, never committed |
| Member GUIDs | A SWID by another name |
| Manager names, team names, free text | 010's boundary: numeric identifiers only |
| URLs | Carry ids and tokens in query strings |

Player names **are** permitted: they are public NFL rosters, they are already in
`tests/fixtures/espn/kona-players.json`, and a board without them is unreadable
in a diff.

Screening happens **at admission, before the write** (FR-021) — not as a
post-hoc sweep. The sweep is the backstop, not the gate. This distinction is the
one that failed before: `privacy-sweep.ts` records that real member names once
shipped to a public repo while it printed "clean", because it carried its own
copy of the matching logic and the copy was wrong.

---

## Reading fixtures from tests

`tests/lab/**` stays inside the root tsconfig, which has **no node types** — so
there is no `node:fs` (research §8). Fixtures load through Vite's build-time
transform, the same mechanism `tests/engine/purity.test.ts` uses:

```ts
import.meta.glob("../fixtures/lab/*.draft.json", { query: "?raw", import: "default", eager: true })
```

`import.meta.glob` is rewritten by Vite at build time and only recognises the
**literal** call form. It cannot be aliased or factored into a helper — doing so
leaves a real property access at runtime, which does not exist. 006 hit exactly
this and the note is repeated here so it is not rediscovered.

Scripts are outside the tsconfig include and read fixtures with `node:fs`
normally.

---

## Invariants a reader must enforce

Checked on load, not assumed — a corpus is only as good as its refusal to load a
bad entry.

1. `picks` sorted, unique on `overall`, contiguous from 1 except where `gaps`
   says otherwise.
2. `useClass: "replayable"` ⇒ non-null `myTeamId`, non-empty `order`, empty
   `gaps`, and a matching `InputSnapshot` whose `entryId` agrees.
3. `useClass: "pick_sequence_only"` ⇒ non-null `unreplayableReason`.
4. `totalPicks` reconciles with `picks.length + gaps.length`, **or** the entry is
   marked unreplayable. Keeper leagues legitimately differ from teams × rounds,
   which is why this is a check and not an assumption.
5. No `playerId` is filtered on sign anywhere. `−1` is the empty-slot sentinel;
   D/ST ids near −16000 are real players. `playerId > 0` is the bug that made
   010's capture report 66 of 72 picks for a complete draft.
6. `InputSnapshot.players` is non-empty.

Failing any invariant is a load error naming the entry and the invariant — never
a silently skipped draft, which would shrink a corpus without anyone noticing.
