// 008 T054 — the only randomness in this feature.
//
// `Math.random` is banned across `src/lab/**` by `tests/lab/boundary.test.ts`,
// for one reason: a simulation that cannot be reproduced cannot be compared,
// and a comparison is the entire product. Every simulated result carries the
// seed that produced it, so "run it again and see" is always available.
//
// mulberry32 — 32-bit state, one multiply-xor-shift round. Chosen because it
// fits in eight lines that can be read and verified, and because a corpus that
// depends on a generator should not depend on a dependency.

/** A seeded generator. Returns values in [0, 1), like `Math.random`. */
export function mulberry32(seed: number): () => number {
  // `>>> 0` pins the state to an unsigned 32-bit integer so a negative or
  // fractional seed still produces a well-defined stream rather than NaN.
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Approximately normal, mean 0, standard deviation 1.
 *
 * Sum of twelve uniforms minus six — the Irwin–Hall approximation. Box–Muller
 * would be more exact in the tails, but this needs no trigonometry, cannot
 * produce an infinity from a zero draw, and its tails are bounded at ±6, which
 * is a feature here: an opponent model with unbounded noise occasionally drafts
 * a kicker first overall and calls it variance.
 */
export function gaussian(rand: () => number): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += rand();
  return sum - 6;
}
