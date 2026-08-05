// 006 T008 — the ADP floor detector.
//
// The fixture below is built to PRODUCTION'S MEASURED SHAPE (2026-08-05), not
// to a shape that makes the detector look good:
//
//   145 players spread thinly from ADP 1.8 to 150
//    52 players from 150 to 169
//   325 players packed into 169.0 – 171.6
//
// The whole point of the density approach is that the exact ratio does not
// matter. So the central test runs the detector at ratios from 5 to 50 and
// requires the same answer — if that ever stops holding, the constant has
// become load-bearing and the rationale in `constants.ts` has become a lie.

import { describe, expect, it, vi } from "vitest";
import { adpIsUsable, detectAdpFloor } from "../../src/projections/adpFloor";

/** Production's shape: a thin spread, then a wall at the top. */
function productionShaped(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 145; i++) out.push(1.8 + (i * (150 - 1.8)) / 145);
  for (let i = 0; i < 52; i++) out.push(150 + (i * 19) / 52);
  // 325 players in a 2.6-unit band — about 125 per unit, against about 1 per
  // unit below 150.
  for (let i = 0; i < 325; i++) out.push(169.0 + (i % 27) * 0.1);
  return out;
}

describe("detectAdpFloor", () => {
  it("finds the saturation band in production-shaped data", () => {
    const floor = detectAdpFloor(productionShaped());
    expect(floor).not.toBeNull();
    // The boundary must land between the thin region and the wall. Asserting a
    // range rather than a value: the bin width is an implementation detail, and
    // pinning it would make this a change-detector test.
    expect(floor!).toBeGreaterThan(160);
    expect(floor!).toBeLessThanOrEqual(169.5);
  });

  it("classifies the right players as unusable", () => {
    const adps = productionShaped();
    const floor = detectAdpFloor(adps);
    const usable = adps.filter((a) => adpIsUsable(a, floor));
    // ~197 genuinely discriminating values (145 below 150, 52 between).
    expect(usable.length).toBeGreaterThanOrEqual(190);
    expect(usable.length).toBeLessThanOrEqual(210);
    // And the wall is gone.
    expect(usable.filter((a) => a >= 169)).toEqual([]);
  });

  it("gives the SAME answer at every ratio from 5 to 50", async () => {
    // This is the test that earns the sentence in `constants.ts` claiming the
    // constant is not load-bearing. Without it that claim is an assertion about
    // code nobody checked.
    const adps = productionShaped();
    const answers: number[] = [];
    for (const ratio of [5, 10, 20, 35, 50]) {
      vi.resetModules();
      vi.doMock("../../src/engine/constants", async () => {
        const actual = await vi.importActual<typeof import("../../src/engine/constants")>(
          "../../src/engine/constants",
        );
        return { ...actual, FLOOR_DENSITY_RATIO: ratio };
      });
      const mod = await import("../../src/projections/adpFloor");
      const floor = mod.detectAdpFloor(adps);
      expect(floor, `ratio ${ratio} found no floor`).not.toBeNull();
      answers.push(floor!);
    }
    vi.doUnmock("../../src/engine/constants");
    vi.resetModules();
    expect(new Set(answers).size, `ratios disagreed: ${answers.join(", ")}`).toBe(1);
  });

  it("returns null when there IS no floor — an even spread", () => {
    // A season where ESPN publishes a real ADP for everyone. Inventing a floor
    // here would silently discard the top of the board.
    const even = Array.from({ length: 400 }, (_, i) => 1 + (i * 199) / 400);
    expect(detectAdpFloor(even)).toBeNull();
  });

  it("returns null on too few values to have a shape", () => {
    expect(detectAdpFloor([1, 2, 3, 4, 5])).toBeNull();
    expect(detectAdpFloor([])).toBeNull();
  });

  it("returns null when every value is identical", () => {
    // Degenerate rather than saturated: there is no boundary to find, and
    // dividing by a zero span would be the naive failure.
    expect(detectAdpFloor(Array.from({ length: 50 }, () => 170))).toBeNull();
  });

  it("ignores nulls rather than treating them as zero", () => {
    const adps: (number | null)[] = [...productionShaped(), ...Array.from({ length: 300 }, () => null)];
    const floor = detectAdpFloor(adps);
    expect(floor).not.toBeNull();
    expect(floor!).toBeGreaterThan(160);
  });

  it("does NOT mistake a popular mid-board ADP for a floor", () => {
    // A cluster that does not reach the maximum is a consensus pick, not
    // saturation. Walking down from the top is what distinguishes them, and
    // this is the test that fails if someone simplifies that walk away.
    const adps = [
      ...Array.from({ length: 200 }, (_, i) => 1 + (i * 199) / 200),
      // 250 players packed at ~60 — dense, but nowhere near the maximum.
      ...Array.from({ length: 250 }, (_, i) => 60 + (i % 5) * 0.01),
    ];
    const floor = detectAdpFloor(adps);
    expect(floor === null || floor > 150).toBe(true);
  });
});

describe("adpIsUsable", () => {
  it("treats a floored ADP exactly like an absent one (FR-022, SC-012)", () => {
    expect(adpIsUsable(169.99, 168)).toBe(false);
    expect(adpIsUsable(null, 168)).toBe(false);
    expect(adpIsUsable(12.4, 168)).toBe(true);
  });

  it("uses every ADP when no floor was detected", () => {
    expect(adpIsUsable(199, null)).toBe(true);
    expect(adpIsUsable(null, null)).toBe(false);
  });
});
