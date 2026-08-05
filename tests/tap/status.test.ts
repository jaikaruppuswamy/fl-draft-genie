// 010 T040/T041 — the status model and the page-world preflight.
//
// Both exist for one reason: a tap that is silently dead must be impossible.
// FR-017 forbids "relaying nothing while appearing healthy", and in an isolated
// world that is exactly what would happen.

import { describe, expect, it, vi } from "vitest";
import { describe as describeStatus, EXPLANATIONS, isDegraded, type TapStatus } from "../../tap/status";
import vm from "node:vm";
import { install, provePageWorld } from "../../tap/intercept";

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

  /**
   * A GENUINELY separate realm, which is what an isolated world actually is.
   *
   * This matters: the previous version of these tests simulated the isolated
   * world with a scope that had no transport global at all, which is a
   * different failure entirely. The real case is a scope that has a perfectly
   * good `WebSocket` which simply is not the page's — and against that, the old
   * `pageWorld = wrapped.length > 0` check returned TRUE. `node:vm` gives us
   * distinct intrinsics, so the boundary is real rather than mocked.
   */
  const pageRealm = () => {
    const ctx = vm.createContext({ EventTarget });
    return vm.runInContext(
      `({ Object, EventTarget, WebSocket: class extends EventTarget {
          constructor(url) { super(); this.url = url; }
        } })`,
      ctx,
    ) as { Object: ObjectConstructor; WebSocket: unknown; EventTarget: unknown };
  };

  const ourScope = () => {
    class S extends EventTarget { constructor(public url: string) { super(); } }
    return { WebSocket: S, EventTarget, Object };
  };

  it("reports pageWorld=false when there is no transport global to wrap", () => {
    const h = hooks();
    const r = install({ EventTarget } as never, h);
    expect(r.pageWorld).toBe(false);
    expect(r.wrapped).toEqual([]);
  });

  it("REFUSES to claim page-world merely because a global was replaced", () => {
    // The regression test for the shipped bug. Everything the old check looked
    // at is true here: a transport global existed, we replaced it, and our
    // wrapper is installed. It is still the WRONG global — the page's lives in
    // another realm and ESPN would keep using it. The tap must say so.
    const scope = ourScope();
    const page = pageRealm();
    const r = install(scope as never, hooks(), { pageGlobal: page as never, selfGlobal: scope as never });
    expect(r.wrapped).toContain("ws"); // the weak property the old check used
    expect(r.pageWorld).toBe(false); // ...and it is not sufficient
    expect(r.reason).toMatch(/different global/i);
  });

  it("reports pageWorld=false when no page global is available at all", () => {
    // No `unsafeWindow` grant: we are holding `window` and cannot tell the
    // page's from an isolated copy. Unproven must not read as healthy.
    const scope = ourScope();
    const r = install(scope as never, hooks(), { pageGlobal: null, selfGlobal: scope as never });
    expect(r.pageWorld).toBe(false);
    expect(r.reason).toMatch(/unsafeWindow|page global/i);
  });

  it("accepts page-context injection, where unsafeWindow IS window", () => {
    // `@sandbox raw` + `@inject-into page`: one global, and we wrapped it.
    const scope = ourScope();
    const r = install(scope as never, hooks(), { pageGlobal: scope as never, selfGlobal: scope as never });
    expect(r.pageWorld).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("accepts a real sandbox, where unsafeWindow is a genuine cross-realm page handle", () => {
    // Tampermonkey's JS sandbox: our realm differs from the page's, but
    // unsafeWindow really does reach the page global and we wrapped THAT.
    const page = pageRealm();
    const self = ourScope();
    const r = install(page as never, hooks(), { pageGlobal: page as never, selfGlobal: self as never });
    expect(r.pageWorld).toBe(true);
  });

  it("rejects a same-realm object masquerading as the page global", () => {
    // Distinct from `window` but sharing our intrinsics: not a page handle.
    const fake = ourScope();
    const self = ourScope();
    const r = install(fake as never, hooks(), { pageGlobal: fake as never, selfGlobal: self as never });
    expect(r.pageWorld).toBe(false);
    expect(r.reason).toMatch(/same-realm/i);
  });

  it("rejects a page global whose transport is not our wrapper", () => {
    const scope = ourScope();
    const r = install(scope as never, hooks(), { pageGlobal: scope as never, selfGlobal: scope as never });
    expect(r.pageWorld).toBe(true);
    // ESPN (or another extension) replaces the global after us: we are no
    // longer what `new WebSocket` resolves to, and must stop claiming health.
    (scope as { WebSocket: unknown }).WebSocket = class {};
    const again = provePageWorld(scope as never, r.wrapped, {
      pageGlobal: scope as never,
      selfGlobal: scope as never,
    });
    expect(again.pageWorld).toBe(false);
    expect(again.reason).toMatch(/not our wrapper/i);
  });

  it("reports an error rather than throwing when the scope is unusable", () => {
    const h = hooks();
    const r = install({} as never, h);
    expect(r.pageWorld).toBe(false);
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("EventTarget"));
  });
});
