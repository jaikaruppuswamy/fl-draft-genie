// Curated O-line file validation (004 SC-005/FR-003/FR-008).

import { describe, expect, it } from "vitest";
import { validateCuratedOline, loadCuratedOline } from "../../src/signals/curated";
import { replaceSignalKind, getSignalMaps } from "../../src/db/signals";
import { makeEnv } from "../helpers/app";
import valid from "../fixtures/signals/oline-valid.json";
import invalid31 from "../fixtures/signals/oline-invalid-31.json";
import invalidDupe from "../fixtures/signals/oline-invalid-dupe-rank.json";

const ABBREVS = new Map<string, number>([
  ["ATL", 1],
  ["BUF", 2],
  ["DEN", 7],
  ["GB", 9],
  ["LAR", 14],
  ["NO", 18],
  ["PHI", 21],
]);

describe("curated O-line validation (SC-005)", () => {
  it("accepts a valid 32-entry permutation and resolves known abbrevs", () => {
    const result = validateCuratedOline(valid);
    expect(result.ok).toBe(true);
  });

  it("rejects a 31-entry file loudly", () => {
    const result = validateCuratedOline(invalid31);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/32/);
  });

  it("rejects non-permutation ranks", () => {
    const result = validateCuratedOline(invalidDupe);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/permutation|rank/i);
  });

  it("an invalid reload leaves previously stored rows unchanged (FR-008)", async () => {
    const env = makeEnv();
    const now = new Date("2026-08-15T09:00:00Z");
    const first = loadCuratedOline(valid, ABBREVS, now);
    expect(first).not.toBeNull();
    await replaceSignalKind(env.DB, "oline", first!);
    const before = (await getSignalMaps(env.DB)).get("oline")!;
    expect(before.size).toBe(ABBREVS.size);

    // Invalid file → loader returns null → caller performs no replace.
    const second = loadCuratedOline(invalid31, ABBREVS, new Date("2026-08-16T09:00:00Z"));
    expect(second).toBeNull();

    const after = (await getSignalMaps(env.DB)).get("oline")!;
    expect(after.size).toBe(before.size);
    expect(after.get(1)?.computed_at).toBe(before.get(1)?.computed_at);
  });

  it("stores only resolvable abbrevs with curated provenance", () => {
    const entries = loadCuratedOline(valid, ABBREVS, new Date("2026-08-15T09:00:00Z"))!;
    expect(entries).toHaveLength(ABBREVS.size);
    expect(entries.every((e) => e.provenance.startsWith("curated:"))).toBe(true);
    const phi = entries.find((e) => e.pro_team_id === 21)!;
    expect(phi.rank).toBe((valid as { entries: { team_abbrev: string; rank: number }[] }).entries.find((x) => x.team_abbrev === "PHI")!.rank);
  });
});
