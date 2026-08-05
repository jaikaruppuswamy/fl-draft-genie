// 010 T026 — the wrapper's safety properties.
//
// This code runs inside a live draft. Every test here corresponds to a way it
// could break the user's draft rather than merely fail to observe it.

import { describe, expect, it, vi } from "vitest";
import { install, isWrapped, wrapConstructor, type InterceptHooks } from "../../tap/intercept";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  constructor(public url: string) { super(); }
  send() { return "sent"; }
  emit(data: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
}

const hooks = (over: Partial<InterceptHooks> = {}): InterceptHooks => ({
  onFrame: vi.fn(),
  onError: vi.fn(),
  isDraftChannel: (u) => u.includes("fantasydraft"),
  defer: (fn) => fn(), // run synchronously so assertions are simple
  ...over,
});

const addEL = EventTarget.prototype.addEventListener;
const wrap = (h: InterceptHooks) => wrapConstructor(FakeSocket as never, "ws", h, addEL);

describe("wrapConstructor — the page must be unaffected", () => {
  it("preserves instanceof in both directions", () => {
    const W = wrap(hooks()) as unknown as typeof FakeSocket;
    expect(new W("wss://fantasydraft/x") instanceof FakeSocket).toBe(true);
    expect(new FakeSocket("x") instanceof (W as never)).toBe(true);
  });

  it("preserves statics, prototype identity and instance methods", () => {
    const W = wrap(hooks()) as unknown as typeof FakeSocket;
    expect(W.OPEN).toBe(1);
    expect(W.prototype).toBe(FakeSocket.prototype);
    expect(new W("wss://fantasydraft/x").send()).toBe("sent");
  });

  it("SUBCLASSING survives — the newTarget property", () => {
    // Without forwarding newTarget, `class C extends Wrapped` loses its own
    // methods. That would break the draft, not just the observation.
    const W = wrap(hooks()) as unknown as typeof FakeSocket;
    class Sub extends W { hello() { return "hi"; } }
    expect(new Sub("wss://fantasydraft/x").hello()).toBe("hi");
  });

  it("a throwing hook never reaches the page's `new`", () => {
    const W = wrap(hooks({ isDraftChannel: () => { throw new Error("boom"); } })) as unknown as typeof FakeSocket;
    let instance: FakeSocket | undefined;
    expect(() => { instance = new W("wss://fantasydraft/x"); }).not.toThrow();
    expect(instance).toBeInstanceOf(FakeSocket);
  });

  it("a throwing frame handler is contained and reported", () => {
    const h = hooks({ onFrame: () => { throw new Error("handler bug"); } });
    const W = wrap(h) as unknown as typeof FakeSocket;
    const s = new W("wss://fantasydraft/x");
    expect(() => s.emit("SELECTED 1 2 3\n")).not.toThrow();
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("frame handler"));
  });

  it("never touches send", () => {
    const W = wrap(hooks()) as unknown as typeof FakeSocket;
    expect(new W("wss://fantasydraft/x").send).toBe(FakeSocket.prototype.send);
  });
});

describe("wrapConstructor — URL scoping", () => {
  it("observes the draft channel", () => {
    const h = hooks();
    const W = wrap(h) as unknown as typeof FakeSocket;
    new W("wss://fantasydraft.espn.com/game-1/league-1/JOIN").emit("SELECTED 1 2 3\n");
    expect(h.onFrame).toHaveBeenCalledWith("SELECTED 1 2 3\n", "ws", expect.stringContaining("fantasydraft"));
  });

  it("ignores ESPN's second, unrelated socket entirely", () => {
    // The US1 capture showed four of these on the same page. Relaying them
    // breaches FR-006 and floods the unrecognised counter with ESPN's own JSON.
    const h = hooks();
    const W = wrap(h) as unknown as typeof FakeSocket;
    new W("wss://espn.connections.edge.bamgrid.com/x").emit('{"data":{"eventId":"x"}}');
    expect(h.onFrame).not.toHaveBeenCalled();
  });

  it("ignores non-string frame payloads without throwing", () => {
    const h = hooks();
    const W = wrap(h) as unknown as typeof FakeSocket;
    expect(() => new W("wss://fantasydraft/x").emit(new ArrayBuffer(8))).not.toThrow();
    expect(h.onFrame).not.toHaveBeenCalled();
  });
});

describe("install", () => {
  it("wraps both transports and reports page-world membership", () => {
    const scope = { WebSocket: FakeSocket, EventSource: FakeSocket, EventTarget, Object };
    // The probe must be supplied. Wrapping a global says nothing about WHOSE
    // global it is, so without a page handle `pageWorld` is unproven, not true
    // — see the preflight tests in status.test.ts.
    const r = install(scope as never, hooks(), { pageGlobal: scope as never, selfGlobal: scope as never });
    expect(r.wrapped).toEqual(["ws", "sse"]);
    expect(r.pageWorld).toBe(true);
    expect(isWrapped(scope.WebSocket)).toBe(true);
  });

  it("wraps successfully but withholds page-world when no page handle is given", () => {
    const scope = { WebSocket: FakeSocket, EventSource: FakeSocket, EventTarget, Object };
    const r = install(scope as never, hooks());
    expect(r.wrapped).toEqual(["ws", "sse"]);
    expect(r.pageWorld).toBe(false);
  });

  it("is idempotent — a second install does not double-wrap", () => {
    const scope = { WebSocket: FakeSocket, EventSource: FakeSocket, EventTarget };
    install(scope as never, hooks());
    const once = scope.WebSocket;
    install(scope as never, hooks());
    expect(scope.WebSocket).toBe(once);
  });

  it("reports failure rather than pretending to work when there is nothing to wrap", () => {
    const h = hooks();
    const r = install({ EventTarget } as never, h);
    expect(r.pageWorld).toBe(false);
    expect(r.wrapped).toEqual([]);
  });
});
