// 008 T054 — the seeded generator.
//
// `Math.random` is banned across the lab core because a simulation that cannot
// be reproduced cannot be compared, and a comparison is the entire product.

import { describe, expect, it } from "vitest";
import { gaussian, mulberry32 } from "../../src/lab/rng";

describe("mulberry32", () => {
  it("gives the same stream for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const left = Array.from({ length: 20 }, () => a());
    const right = Array.from({ length: 20 }, () => b());
    expect(left).toEqual(right);
  });

  it("gives a different stream for a different seed", () => {
    const a = Array.from({ length: 20 }, mulberry32(1));
    const b = Array.from({ length: 20 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it("stays within [0, 1)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("handles a negative or fractional seed without producing NaN", () => {
    // `>>> 0` pins the state to an unsigned 32-bit integer. Without it a
    // negative seed silently yields NaN and every draw downstream is NaN.
    for (const seed of [-1, -99999, 3.7, 0]) {
      const rand = mulberry32(seed);
      const v = rand();
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not immediately repeat", () => {
    const rand = mulberry32(123);
    const seen = new Set(Array.from({ length: 1000 }, rand));
    expect(seen.size).toBeGreaterThan(990);
  });
});

describe("gaussian", () => {
  it("is reproducible from a seed", () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect(gaussian(a)).toBe(gaussian(b));
  });

  it("has roughly mean 0 and standard deviation 1", () => {
    const rand = mulberry32(99);
    const draws = Array.from({ length: 20000 }, () => gaussian(rand));
    const mean = draws.reduce((x, y) => x + y, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, d) => a + (d - mean) ** 2, 0) / draws.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
  });

  it("has BOUNDED tails at ±6", () => {
    // Deliberate. An opponent model with unbounded noise occasionally drafts a
    // kicker first overall and calls it variance.
    const rand = mulberry32(31337);
    for (let i = 0; i < 20000; i++) {
      const v = gaussian(rand);
      expect(v).toBeGreaterThanOrEqual(-6);
      expect(v).toBeLessThanOrEqual(6);
    }
  });
});
