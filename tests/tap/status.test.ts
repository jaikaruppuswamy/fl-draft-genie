// 010 T040/T041 — the status model and the page-world preflight.
//
// Both exist for one reason: a tap that is silently dead must be impossible.
// FR-017 forbids "relaying nothing while appearing healthy", and in an isolated
// world that is exactly what would happen.

import { describe, expect, it, vi } from "vitest";
import { describe as describeStatus, EXPLANATIONS, isDegraded, type TapStatus } from "../../tap/status";
import { install } from "../../tap/intercept";

const status = (over: Partial<TapStatus> = {}): TapStatus => ({
  state: "relaying",
  tapVersion: "0.1.0",
  lastRelayedAt: null,
  buffered: 0,
  unrecognisedCount: 0,
  detail: "",
  ...over,
});

describe("status model", () => {
  // FR-016: each failure mode reported distinctly, in plain language, with what
  // to do about it.
  it("gives every state a plain-language explanation, not a bare code", () => {
    for (const [state, text] of Object.entries(EXPLANATIONS)) {
      expect(text.length, state).toBeGreaterThan(20);
      expect(text, state).toMatch(/[a-z]\s[a-z]/i);
    }
  });

  it("distinguishes draft-finished from watching (SC-014)", () => {
    // Idle and dead must never look the same.
    expect(EXPLANATIONS["draft-finished"]).not.toBe(EXPLANATIONS.watching);
    expect(isDegraded(status({ state: "draft-finished" }))).toBe(false);
  });

  it("treats an unrecognised message as degraded even while relaying", () => {
    // ESPN silently drops verbs it does not know; we deliberately do not.
    expect(isDegraded(status({ state: "relaying", unrecognisedCount: 1 }))).toBe(true);
    expect(isDegraded(status({ state: "relaying" }))).toBe(false);
  });

  it("treats buffering, version-rejected and incompatible as degraded", () => {
    for (const state of ["buffering", "version-rejected", "incompatible"] as const) {
      expect(isDegraded(status({ state })), state).toBe(true);
    }
  });

  it("says what to do about an incompatible tap, not just that it is broken", () => {
    expect(EXPLANATIONS.incompatible).toMatch(/NOT being captured/);
    expect(EXPLANATIONS.incompatible).toMatch(/update/i);
  });

  it("describes a state as label plus explanation", () => {
    expect(describeStatus(status({ state: "buffering" }))).toContain("buffering:");
  });
});

describe("page-world preflight", () => {
  const hooks = () => ({
    onFrame: vi.fn(),
    onError: vi.fn(),
    isDraftChannel: () => true,
    defer: (fn: () => void) => fn(),
  });

  it("reports pageWorld=false when there is no transport global to wrap", () => {
    // This is the isolated-world case: `window.WebSocket` is not the page's, so
    // the tap would observe nothing while looking perfectly healthy.
    const h = hooks();
    const r = install({ EventTarget } as never, h);
    expect(r.pageWorld).toBe(false);
    expect(r.wrapped).toEqual([]);
  });

  it("reports pageWorld=true only once a global was actually replaced", () => {
    class S extends EventTarget { constructor(public url: string) { super(); } }
    const scope = { WebSocket: S, EventTarget };
    const r = install(scope as never, hooks());
    expect(r.pageWorld).toBe(true);
    expect(scope.WebSocket).not.toBe(S);
  });

  it("reports an error rather than throwing when the scope is unusable", () => {
    const h = hooks();
    const r = install({} as never, h);
    expect(r.pageWorld).toBe(false);
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("EventTarget"));
  });
});
