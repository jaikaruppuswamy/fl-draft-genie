// 008 T008 — the codec, and the byte-identity that every later comparison
// silently depends on.
//
// If two assemblies of the same bundle serialize differently, a comparison
// between two rule sets reports movement that no rule caused — and it reports
// it in exactly the format a real finding would take.

import { describe, expect, it } from "vitest";
import {
  bundleToSnapshot,
  canonicalHash,
  canonicalJson,
  snapshotToBundle,
  SNAPSHOT_FORMAT_VERSION,
  type InputSnapshot,
} from "../../src/lab/codec";
import { boardEntry, bundle, signal } from "./helpers";

const SOURCE = { entryId: "test-2026", sourceSetRef: "set-1", sourceSetFetchedAt: "2026-08-04T12:00:00.000Z" };

describe("bundleToSnapshot / snapshotToBundle", () => {
  it("round-trips, restoring Map and Set", () => {
    const original = bundle();
    const back = snapshotToBundle(bundleToSnapshot(original, SOURCE));

    expect(back.signals).toBeInstanceOf(Map);
    expect(back.preferred).toBeInstanceOf(Set);
    expect(back.proTeamByPlayer).toBeInstanceOf(Map);
    expect(back.signals.get("offense")?.get(25)?.score).toBe(75);
    expect(back.teamCount).toBe(original.teamCount);
    expect(back.players.map((p) => p.espn_player_id).sort()).toEqual(
      original.players.map((p) => p.espn_player_id).sort(),
    );
  });

  it("round-trips a preferred list and an ADP floor", () => {
    const original = bundle({ preferred: new Set([1003, 1001]), adpFloor: 169.9 });
    const back = snapshotToBundle(bundleToSnapshot(original, SOURCE));
    expect([...back.preferred].sort()).toEqual([1001, 1003]);
    expect(back.adpFloor).toBe(169.9);
  });

  it("leaves an absent signal kind ABSENT rather than inserting it empty", () => {
    // The engine distinguishes "no signal" from "a signal of zero" and says so
    // in its explanation. An empty Map would claim we looked and found nothing.
    const back = snapshotToBundle(bundleToSnapshot(bundle(), SOURCE));
    expect(back.signals.has("offense")).toBe(true);
    expect(back.signals.has("sos")).toBe(false);
    expect(back.signals.has("oline")).toBe(false);
  });

  it("keeps a negative D/ST player id through the round trip", () => {
    const back = snapshotToBundle(bundleToSnapshot(bundle(), SOURCE));
    expect(back.players.some((p) => p.espn_player_id === -16001)).toBe(true);
    expect(back.proTeamByPlayer.has(-16001)).toBe(true);
  });

  it("trims proTeamByPlayer to players on the board", () => {
    // A drafted player missing from the board is already tolerated downstream,
    // so carrying the whole universe inflates every fixture for no behavioural
    // difference.
    const b = bundle();
    b.proTeamByPlayer.set(999_999, 12);
    const snap = bundleToSnapshot(b, SOURCE);
    expect(snap.proTeamByPlayer.some(([id]) => id === 999_999)).toBe(false);
    expect(snap.proTeamByPlayer.length).toBe(b.players.length);
  });

  it("refuses an unknown snapshot version loudly", () => {
    const snap = { ...bundleToSnapshot(bundle(), SOURCE), formatVersion: 99 } as InputSnapshot;
    expect(() => snapshotToBundle(snap)).toThrow(/unknown snapshot format version 99/);
    expect(() => snapshotToBundle(snap)).toThrow(new RegExp(String(SNAPSHOT_FORMAT_VERSION)));
  });
});

describe("canonical form", () => {
  it("produces byte-identical output from two different input orderings", () => {
    // THE assertion this file exists for. The same bundle assembled from
    // differently-ordered query results must serialize to the same bytes, or
    // every later comparison reports movement no rule caused.
    const players = bundle().players;
    const forward = bundle({
      players: [...players],
      preferred: new Set([1001, 1003]),
      signals: new Map([["offense", new Map([[25, signal()], [12, signal({ rank: 3 })]])]]),
    });
    const reversed = bundle({
      players: [...players].reverse(),
      preferred: new Set([1003, 1001]),
      signals: new Map([["offense", new Map([[12, signal({ rank: 3 })], [25, signal()]])]]),
    });

    const a = canonicalJson(bundleToSnapshot(forward, SOURCE));
    const b = canonicalJson(bundleToSnapshot(reversed, SOURCE));
    expect(a).toBe(b);
    expect(canonicalHash(bundleToSnapshot(forward, SOURCE))).toBe(
      canonicalHash(bundleToSnapshot(reversed, SOURCE)),
    );
  });

  it("sorts object keys at every level", () => {
    const text = canonicalJson({ z: 1, a: { y: 2, b: 3 } });
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));
    expect(text.indexOf('"b"')).toBeLessThan(text.indexOf('"y"'));
  });

  it("ends with a trailing newline and uses two-space indent", () => {
    const text = canonicalJson({ a: 1 });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "a": 1');
  });

  it("rounds to the requested precision, and only when asked", () => {
    expect(canonicalJson({ v: 1.23456789 }, { round: 4 })).toContain("1.2346");
    expect(canonicalJson({ v: 1.23456789 })).toContain("1.23456789");
  });

  it("does not re-round board values in a snapshot", () => {
    // Board values carry the engine's own rounding. Re-rounding them would
    // change the input a replay is run against — a silent edit to the evidence.
    const b = bundle({ players: [boardEntry({ espn_player_id: 1, projected_points: 123.456789 })] });
    expect(canonicalJson(bundleToSnapshot(b, SOURCE))).toContain("123.456789");
  });

  it("collapses -0 to 0 when rounding", () => {
    // They stringify differently and mean the same thing — exactly the kind of
    // difference that reads as a rule effect in a diff.
    expect(canonicalJson({ v: -0.00001 }, { round: 4 })).toBe(canonicalJson({ v: 0 }, { round: 4 }));
  });

  it("leaves array order alone — arrays are sorted by their producer, not here", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]\n");
  });
});

describe("canonicalHash", () => {
  it("is stable across calls", () => {
    const v = { a: 1, b: [1, 2, 3] };
    expect(canonicalHash(v)).toBe(canonicalHash(v));
  });

  it("changes when any value changes", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it("is insensitive to key order, which is the point", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it("is a fixed-width hex digest", () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});
