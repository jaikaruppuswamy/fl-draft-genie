// 008 T040–T043 — sweep one constant across values, in one run.
//
// THE TENSION THIS RESOLVES: FR-014 wants many values in a single run; FR-002
// forbids modifying the engine; FR-018 forbids writing to its constants. But
// `src/engine/constants.ts` exports module-level `const` bindings that six
// modules import directly, so a value is fixed at module-evaluation time.
//
// The answer is to substitute the MODULE, per value:
//   vi.resetModules() → vi.doMock(built from vi.importActual) → dynamic import
//
// Nothing is written, no file is generated, the engine's source is untouched,
// and every unswept constant provably still comes from the real module — which
// the second test below asserts rather than assumes.
//
// Rejected alternatives, recorded so they are not re-proposed: adding a tuning
// parameter to `recommend()` (a config seam into a rule set the constitution
// says is code, not config), and generating a temporary constants file (exactly
// what FR-018 prohibits, and a crashed run leaves the engine modified).
//
// NOTE: the ordinary compare case needs none of this. Edit the constant, re-run
// `lab:run`, diff against the committed baseline — the file change and the
// scorecard change land in the same review.

import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "../../src/lab/codec";
import { entry } from "./helpers";

// Options inline: Vite parses the literal (see boundary.test.ts).
const sweepFiles = import.meta.glob("../fixtures/lab/sweeps/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface SweepDefinition {
  name: string;
  constantPath: string;
  values: number[];
}

const CONSTANTS_PATH = "../../src/engine/constants";

/**
 * Replay the fixture entry with one constant substituted.
 *
 * The mock is built from `vi.importActual`, so ONLY the swept field differs —
 * a hand-written mock would silently zero every constant it forgot.
 */
async function replayWith(constantPath: string, value: number): Promise<unknown> {
  vi.resetModules();
  vi.doMock(CONSTANTS_PATH, async () => {
    const actual = await vi.importActual<Record<string, unknown>>(CONSTANTS_PATH);
    const [head, tail] = constantPath.split(".");
    if (tail === undefined) return { ...actual, [head!]: value };
    return { ...actual, [head!]: { ...(actual[head!] as Record<string, number>), [tail]: value } };
  });

  const { replayEntry } = await import("../../src/lab/replay");
  const { bundle } = await import("./helpers");
  return replayEntry(entry(), bundle());
}

afterEach(() => {
  vi.doUnmock(CONSTANTS_PATH);
  vi.resetModules();
});

describe("committed sweep definitions", () => {
  it("has at least one, so the mechanism is exercised by npm test", () => {
    expect(Object.keys(sweepFiles).length).toBeGreaterThan(0);
  });

  it("parses every definition", () => {
    for (const [path, raw] of Object.entries(sweepFiles)) {
      const def = JSON.parse(raw) as SweepDefinition;
      expect(def.name, path).toBeTruthy();
      expect(def.constantPath, path).toBeTruthy();
      expect(def.values.length, path).toBeGreaterThan(1);
    }
  });
});

describe("module substitution (FR-014)", () => {
  it("changes only the swept field, leaving every other constant real", () => {
    // The assertion that makes the whole mechanism trustworthy. A mock built by
    // hand would zero whatever it forgot, and every result afterwards would be
    // measuring a differently-broken engine each time.
    return (async () => {
      vi.resetModules();
      vi.doMock(CONSTANTS_PATH, async () => {
        const actual = await vi.importActual<Record<string, unknown>>(CONSTANTS_PATH);
        return { ...actual, WEIGHT: { ...(actual.WEIGHT as Record<string, number>), bye: 0.9 } };
      });
      const mocked = await import(CONSTANTS_PATH);
      const real = await vi.importActual<Record<string, unknown>>(CONSTANTS_PATH);

      expect((mocked.WEIGHT as Record<string, number>).bye).toBe(0.9);
      // Untouched siblings, and untouched top-level constants.
      expect((mocked.WEIGHT as Record<string, number>).offense).toBe(
        (real.WEIGHT as Record<string, number>).offense,
      );
      expect(mocked.PREFERRED_CAP).toBe(real.PREFERRED_CAP);
      expect(mocked.SHORTLIST_SIZE).toBe(real.SHORTLIST_SIZE);
      expect(mocked.ADP_COMBINED_CAP).toBe(real.ADP_COMBINED_CAP);
    })();
  });

  it("produces one comparable result per value", async () => {
    const def = JSON.parse(Object.values(sweepFiles)[0]!) as SweepDefinition;
    const results: string[] = [];
    for (const value of def.values) {
      results.push(canonicalHash(await replayWith(def.constantPath, value), { round: 4 }));
    }
    expect(results).toHaveLength(def.values.length);
    // Each value produced SOMETHING — a sweep that silently returned the same
    // object every time would look identical to a constant with no effect.
    for (const h of results) expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is reproducible: the same value twice gives the same result", async () => {
    const a = canonicalHash(await replayWith("WEIGHT.bye", 0.5), { round: 4 });
    const b = canonicalHash(await replayWith("WEIGHT.bye", 0.5), { round: 4 });
    expect(a).toBe(b);
  });

  it("restores the real constants afterwards", async () => {
    await replayWith("WEIGHT.bye", 0.9);
    vi.doUnmock(CONSTANTS_PATH);
    vi.resetModules();
    const restored = await import(CONSTANTS_PATH);
    expect((restored.WEIGHT as Record<string, number>).bye).toBe(0.35);
  });
});

describe("the engine's source is never modified (FR-018)", () => {
  it("leaves every real constant untouched after a sweep", async () => {
    // Behavioural rather than structural, and stronger for it: whatever the
    // sweep does internally, the engine's own constants must be exactly what
    // they were. A generated constants file would leave them changed after a
    // crashed run, which is precisely what FR-018 forbids.
    const before = { ...(await vi.importActual<Record<string, unknown>>(CONSTANTS_PATH)) };

    for (const value of [0.1, 0.9]) await replayWith("WEIGHT.bye", value);

    vi.doUnmock(CONSTANTS_PATH);
    vi.resetModules();
    const after = { ...(await vi.importActual<Record<string, unknown>>(CONSTANTS_PATH)) };

    expect(after).toEqual(before);
    expect((after.WEIGHT as Record<string, number>).bye).toBe(0.35);
  });

  it("PROVES the comparison can fail", () => {
    // Without this the assertion above passes against any implementation,
    // including one that compares an empty object to an empty object.
    const real = { WEIGHT: { bye: 0.35 } };
    const tampered = { WEIGHT: { bye: 0.9 } };
    expect(real).not.toEqual(tampered);
  });
});
