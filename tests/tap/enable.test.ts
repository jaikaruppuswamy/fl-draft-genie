// 011 T025/T031 — what may cause an enablement, and what may never.
//
// FR-018: enabling MUST require a genuine user action and MUST NOT be
// triggerable by a page the owner merely visits. The output of this gate is a
// 180-day bearer credential, so every condition is required and none is scored.
//
// The structural half of this file (T031) is the one that would catch a
// regression nobody meant: the shipped bundle must contain no `message`
// listener, because `postMessage` is the only channel that crosses origins.
// Its ABSENCE is the guarantee, and absence is exactly what a behavioural test
// cannot observe.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateGesture, REFUSAL_COPY, REDEEM_COPY, type GestureInput } from "../../tap/enable";

/** A click that should mint. Each test breaks exactly one thing. */
const good = (over: Partial<GestureInput> = {}): GestureInput => ({
  isTrusted: true,
  button: 0,
  activationActive: true,
  pathHasTarget: true,
  inDocument: true,
  hasBox: true,
  topFrame: true,
  originMatches: true,
  nativesIntact: true,
  ...over,
});

describe("a genuine click mints", () => {
  it("accepts the real thing — PROVES the gate is not simply closed", () => {
    // Without this every refusal below passes against `() => ({mint: false})`,
    // and nobody could ever enable the tap.
    expect(evaluateGesture(good())).toEqual({ mint: true });
  });
});

describe("a page the owner merely visits cannot cause enablement (FR-018)", () => {
  // Each of these is a way a hostile or careless page could try to get the
  // script to hand out a credential without anyone deciding to.

  it("refuses a synthetic click", () => {
    // `el.click()` or a constructed MouseEvent. isTrusted is the browser's own
    // word, and a page cannot forge it on a real event.
    expect(evaluateGesture(good({ isTrusted: false }))).toEqual({
      mint: false,
      reason: "not_trusted",
    });
  });

  it("refuses a click with no user activation behind it", () => {
    // The independent check on isTrusted: the browser separately tracks whether
    // the page is inside a real gesture, and a replayed or deferred handler is
    // not.
    expect(evaluateGesture(good({ activationActive: false }))).toEqual({
      mint: false,
      reason: "no_user_activation",
    });
  });

  it("refuses a click on anything that is not the enable control", () => {
    // The bypass that does not need to forge anything: put the marker attribute
    // on <body> and wait for the victim's next genuine click anywhere.
    expect(evaluateGesture(good({ pathHasTarget: false }))).toEqual({
      mint: false,
      reason: "not_the_enable_control",
    });
  });

  it("refuses a detached decoy", () => {
    expect(evaluateGesture(good({ inDocument: false }))).toEqual({
      mint: false,
      reason: "target_not_in_document",
    });
  });

  it("refuses an invisible or zero-sized control", () => {
    // A 0×0 element under the cursor is the classic clickjacking shape.
    expect(evaluateGesture(good({ hasBox: false }))).toEqual({
      mint: false,
      reason: "target_not_visible",
    });
  });

  it("refuses inside a frame", () => {
    // A framed button clicked through an overlay is the owner merely visiting
    // somebody else's page. `@noframes` should already prevent this; asserted
    // because the metadata block is one line away from not saying it.
    expect(evaluateGesture(good({ topFrame: false }))).toEqual({ mint: false, reason: "framed" });
  });

  it("refuses on any origin that is not ours", () => {
    expect(evaluateGesture(good({ originMatches: false }))).toEqual({
      mint: false,
      reason: "not_our_origin",
    });
  });

  it("refuses when the natives it relies on were replaced", () => {
    // Same posture as the paste flow's refusal when `prompt()` was replaced:
    // decline rather than proceed. A credential is not revocable by the person
    // who lost it.
    expect(evaluateGesture(good({ nativesIntact: false }))).toEqual({
      mint: false,
      reason: "natives_replaced",
    });
  });

  it("refuses a non-primary button", () => {
    expect(evaluateGesture(good({ button: 1 }))).toEqual({
      mint: false,
      reason: "not_primary_button",
    });
  });
});

describe("the outermost problem is the one reported", () => {
  it("names `framed` over the inner failures when several are true", () => {
    // A refusal should name the thing the attacker controls, not the symptom.
    expect(evaluateGesture(good({ topFrame: false, isTrusted: false, hasBox: false }))).toEqual({
      mint: false,
      reason: "framed",
    });
  });
});

describe("every refusal says what to do (FR-021)", () => {
  it("has copy for every reason the gate can return", () => {
    // A state without a remedy is the silent failure this feature exists to
    // stop. Checked as a closed set, not case by case.
    const reasons: GestureInput[] = [
      good({ originMatches: false }),
      good({ topFrame: false }),
      good({ nativesIntact: false }),
      good({ isTrusted: false }),
      good({ button: 2 }),
      good({ activationActive: false }),
      good({ pathHasTarget: false }),
      good({ inDocument: false }),
      good({ hasBox: false }),
    ];
    for (const i of reasons) {
      const v = evaluateGesture(i);
      expect(v.mint).toBe(false);
      if (!v.mint) expect(REFUSAL_COPY[v.reason], v.reason).toBeTruthy();
    }
    expect(Object.keys(REFUSAL_COPY)).toHaveLength(9);
  });

  it("names no credential, code or token in any message (FR-017)", () => {
    // The whole point of the feature is that the owner never handles one, so no
    // message may tell them to go and find one.
    for (const copy of [...Object.values(REFUSAL_COPY), ...Object.values(REDEEM_COPY)]) {
      expect(copy.toLowerCase()).not.toMatch(/\btoken\b|\bpaste\b|\bcopy\b|\bcode\b|\bcredential\b|\bsecret\b/);
    }
  });

  it("has copy for every server-side failure too", () => {
    expect(Object.keys(REDEEM_COPY)).toHaveLength(6);
    for (const v of Object.values(REDEEM_COPY)) expect(v.length).toBeGreaterThan(10);
  });
});

// --- structural: what the shipped bundle must and must not contain -----------

const BUNDLE = fileURLToPath(new URL("../../web/public/draft-tap.user.js", import.meta.url));

function bundle(): string {
  return readFileSync(BUNDLE, "utf8");
}

/**
 * ONLY the leading metadata block — the one the script manager actually reads.
 *
 * `META_BLOCK` is also bundled as a template literal (it is the single source of
 * the banner, asserted against `TAP_VERSION` by the build), so the file contains
 * the directives twice. Counting both would make "@connect names exactly one
 * host" fail on a script that names exactly one host.
 */
function banner(): string {
  const src = bundle();
  const start = src.indexOf("// ==UserScript==");
  const end = src.indexOf("// ==/UserScript==");
  expect(start, "no metadata banner").toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("the shipped userscript (T027, T031)", () => {
  it("has a bundle to check", () => {
    // Without this the assertions below pass vacuously on an empty read.
    expect(bundle().length).toBeGreaterThan(1000);
  });

  it("registers NO message listener — postMessage is the only cross-origin channel", () => {
    // The guarantee is an absence, which is why it is asserted structurally.
    // A `message` listener could be driven by any page that can get a handle to
    // our window; a CustomEvent on our own document cannot.
    const code = bundle().replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    expect(code).not.toMatch(/addEventListener\(\s*["'`]message["'`]/);
    expect(code).not.toMatch(/onmessage\s*=/);
  });

  it("PROVES that check can fail", () => {
    // A guard that cannot fire is decoration.
    const sample = 'window.addEventListener("message", (e) => {});';
    expect(sample).toMatch(/addEventListener\(\s*["'`]message["'`]/);
  });

  it("matches Draft Genie's origin as well as ESPN, and nothing else", () => {
    const matches = [...banner().matchAll(/^\/\/ @match\s+(\S+)/gm)].map((m) => m[1]!);
    expect(matches).toHaveLength(2);
    expect(matches.some((m) => m.includes("fantasy.espn.com"))).toBe(true);
    expect(matches.some((m) => m.includes("draft.neelamjai.com"))).toBe(true);
  });

  it("still connects to exactly one host", () => {
    // Widening @match must not widen @connect. Where the script may RUN and
    // where it may SEND are different questions, and only the second is a
    // capability.
    const connects = [...banner().matchAll(/^\/\/ @connect\s+(\S+)/gm)].map((m) => m[1]!);
    expect(connects).toEqual(["draft.neelamjai.com"]);
  });

  it("keeps @noframes and document-start", () => {
    // Both are load-bearing: the frame check above assumes the first, and the
    // ESPN interception requires the second.
    expect(banner()).toMatch(/^\/\/ @noframes\s*$/m);
    expect(banner()).toMatch(/^\/\/ @run-at\s+document-start\s*$/m);
  });

  it("never writes a credential into the DOM", () => {
    // FR-017. The marker the page reads must carry the version and nothing else.
    const code = bundle();
    expect(code).not.toMatch(/setAttribute\([^)]*dg:token/);
    expect(code).toMatch(/data-dg-tap/);
  });
});
