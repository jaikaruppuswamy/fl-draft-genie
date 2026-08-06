// 008 T020 — SC-009: the corpus has no shelf life.
//
// THIS IS THE ASSERTION THE WHOLE SNAPSHOT DESIGN EXISTS FOR, and the only one
// that would have caught the problem that reshaped this feature: `pruneSets()`
// runs `DELETE FROM projection_sets WHERE season < ?` on every maintenance
// pass, and `player_projections` cascades from it. Left alone, the one draft
// this lab can replay stops being replayable when the clock rolls to 2027 —
// silently, with every test still green.
//
// "The source set was deleted" cannot be staged here, because there is nothing
// to delete: the point of the design is that no live table is ever consulted.
// So durability is proven the way it is actually guaranteed —
//
//   1. STRUCTURALLY: `replayEntry` takes an entry and a bundle, and the module
//      imports nothing from `src/db/`. There is no code path to a table.
//   2. BEHAVIOURALLY: a snapshot round-tripped through TEXT — the exact bytes
//      a fixture holds, with no live anything in scope — replays identically.
//
// Together those say a fixture committed today produces the same replay in
// 2028, whatever happened to the tables it came from.

import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson, snapshotToBundle, type InputSnapshot } from "../../src/lab/codec";
import { replayEntry } from "../../src/lab/replay";
import type { CorpusEntry } from "../../src/lab/corpus";
import { validateEntry } from "../../src/lab/corpus";

// Options inline: Vite parses the literal (see boundary.test.ts).
const entryFiles = import.meta.glob("../fixtures/lab/*.draft.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
const inputFiles = import.meta.glob("../fixtures/lab/*.inputs.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
const replaySource = import.meta.glob("../../src/lab/replay.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

function loadPair(name: string): { entry: CorpusEntry; snapshot: InputSnapshot } {
  const entryRaw = Object.entries(entryFiles).find(([p]) => p.includes(name))?.[1];
  const inputRaw = Object.entries(inputFiles).find(([p]) => p.includes(name))?.[1];
  if (!entryRaw || !inputRaw) throw new Error(`fixture ${name} not found`);
  return { entry: JSON.parse(entryRaw) as CorpusEntry, snapshot: JSON.parse(inputRaw) as InputSnapshot };
}

describe("the committed fixture loads and satisfies its own invariants", () => {
  it("finds the synthetic corpus entry", () => {
    // Guards against a vacuous suite: 006's M7 mutation reported SURVIVED
    // because only 10 of 102 tests actually ran, and the test COUNT is what
    // caught it.
    expect(Object.keys(entryFiles).length).toBeGreaterThan(0);
    expect(Object.keys(inputFiles).length).toBeGreaterThan(0);
  });

  it("passes validation with its snapshot present", () => {
    const { entry, snapshot } = loadPair("synthetic-2026");
    expect(validateEntry(entry, true)).toEqual([]);
    expect(snapshot.entryId).toBe(entry.id);
  });

  it("is classified as a test run, so it can never become evidence", () => {
    const { entry } = loadPair("synthetic-2026");
    expect(entry.provenanceClass).toBe("test");
  });
});

describe("SC-009 — a snapshot replays identically with no live table in scope", () => {
  it("replays from fixture text alone", () => {
    const { entry, snapshot } = loadPair("synthetic-2026");
    const result = replayEntry(entry, snapshotToBundle(snapshot));
    expect(result.turns.length).toBeGreaterThan(0);
    for (const t of result.turns) expect(t.engineHead).not.toBeNull();
  });

  it("gives the same answer after a full text round trip", () => {
    // Serialize the snapshot, throw the object away, parse the bytes back. This
    // is precisely what happens when a fixture is read in 2028: nothing from
    // today's process, and nothing from today's database, is in scope.
    const { entry, snapshot } = loadPair("synthetic-2026");
    const before = replayEntry(entry, snapshotToBundle(snapshot));

    const rehydrated = JSON.parse(canonicalJson(snapshot)) as InputSnapshot;
    const after = replayEntry(entry, snapshotToBundle(rehydrated));

    expect(canonicalHash(after, { round: 4 })).toBe(canonicalHash(before, { round: 4 }));
  });

  it("PROVES the comparison can fail", () => {
    // Without this, the assertion above passes against any implementation —
    // including one that returns an empty result for both sides.
    const { entry, snapshot } = loadPair("synthetic-2026");
    const before = replayEntry(entry, snapshotToBundle(snapshot));
    const damaged = snapshotToBundle(snapshot);
    damaged.preferred.add(damaged.players[10]!.espn_player_id);
    const after = replayEntry(entry, damaged);
    expect(canonicalHash(after, { round: 4 })).not.toBe(canonicalHash(before, { round: 4 }));
  });
});

describe("the replay has no path to a live table (FR-019b)", () => {
  it("imports nothing from src/db/", () => {
    // The structural half. A replay that could reach a table would be replayable
    // only until that table changed — which is the decay this feature was
    // reshaped to prevent.
    const source = Object.values(replaySource)[0];
    expect(source).toBeDefined();
    const withoutComments = source!.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    expect(withoutComments).not.toMatch(/from\s+["'][^"']*\/db\//);
    expect(withoutComments).not.toMatch(/\bD1Database\b/);
  });

  it("takes only an entry and a bundle", () => {
    // Arity is a weak signal on its own; paired with the import check above it
    // says there is no other way in.
    expect(replayEntry.length).toBe(2);
  });
});
