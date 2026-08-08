// 016 — the product has no pairing step, so no copy may name one.
//
// WHY THIS EXISTS AT ALL. 011 US3 replaced the pairing ritual with a single
// acknowledgement, and T057/T058 took the old vocabulary out of the web UI by
// hand. Nothing enforced it, so two surfaces kept the removed language for
// months:
//
//   * the badge explanation a freshly installed tap shows on startup, which
//     told a new user to perform a step that does not exist; and
//   * the status dialog, which pointed at a second menu command US3 had
//     deleted — eight lines below a comment recording the deletion.
//
// Both were the FIRST thing someone reads when the tap is not working. A hand
// edit fixed them once and drifted; this makes drifting fail the build.
//
// Asserted against the SHIPPED artifact rather than the source, following
// `passivity.test.ts`: the userscript is built by `npm run build:tap`, which is
// NOT part of `npm run build`, so source and bundle can diverge. Checking the
// bundle is what proves the copy actually reaches a browser.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPLANATIONS } from "../../tap/status";

const bundle = readFileSync("web/public/draft-tap.user.js", "utf8");

/**
 * Instructions to a human, never identifiers.
 *
 * Deliberately NOT /pair/ — that word is load-bearing everywhere and must keep
 * working. `tap_pairings` is the live credential table, `pairing_*` is the 401
 * error code `shouldForgetCredential` compares against, and `not-paired` /
 * `paired` are tap states stored in `draft_sessions.tap_state`. Banning the
 * word would force a rename of a wire contract to satisfy a copy rule.
 *
 * What is banned is the imperative: text telling someone to go and pair
 * something. That phrasing appears only in prose.
 */
const BANNED = [/\bre-?pair\b/i, /\bpair this\b/i, /paste pairing token/i, /\band pair\b/i];

describe("no user-facing copy names a step the product removed", () => {
  it("every badge explanation is free of it", () => {
    for (const [state, copy] of Object.entries(EXPLANATIONS)) {
      for (const banned of BANNED) {
        expect(banned.test(copy), `${state}: ${copy}`).toBe(false);
      }
    }
  });

  it("the shipped bundle is free of it, comments included", () => {
    // Comments survive the build, and one quoting a banned phrase would be a
    // false positive — so the source comments describe these phrases without
    // reproducing them. That is a deliberate constraint, noted in `status.ts`.
    for (const banned of BANNED) {
      expect(bundle).not.toMatch(banned);
    }
  });

  it("PROVES the check can fail — the exact copy that shipped for months", () => {
    // Without this, a typo in every pattern above would leave the suite green
    // and the guard asleep. These are the two strings this feature removed.
    const wasShipped = "Not linked to Draft Genie yet. Open Draft Genie settings and pair this browser.";
    const alsoShipped = 'NO — use "paste pairing token" below';
    expect(BANNED.some((b) => b.test(wasShipped))).toBe(true);
    expect(BANNED.some((b) => b.test(alsoShipped))).toBe(true);
  });

  it("leaves the wire contract alone", () => {
    // The companion to the rule above: these MUST survive, and a future
    // over-eager cleanup that renames them breaks credential handling for every
    // installed tap. `pairing_missing_install` is the one 401 the tap must NOT
    // treat as a dead credential.
    expect(bundle).toMatch(/pairing_missing_install/);
    expect(bundle).toMatch(/not-paired/);
    expect(Object.keys(EXPLANATIONS)).toContain("not-paired");
    expect(Object.keys(EXPLANATIONS)).toContain("paired");
  });
});
