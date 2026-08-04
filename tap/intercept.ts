// 010 T029 — the transport wrapper.
//
// This is the single most dangerous file in the project: it runs inside the
// user's live draft room, and a mistake here breaks their draft rather than
// merely failing to observe it. Every decision below is defensive.
//
// WHY BOTH TRANSPORTS: ESPN is WebSocket-first with an SSE fallback. Its
// selector sends attempt 2 to SSE, reached in ~7s of bad network — so a
// WebSocket-only tap goes dark exactly when the connection is worst. Every
// public implementation has that bug.
//
// WHY newTarget IS FORWARDED: Reflect.construct(target, args) WITHOUT the third
// argument silently destroys subclassing — `class C extends EventSource` loses
// its own methods. Verified. If ESPN's client subclasses its transport, omitting
// it breaks the draft in the one way FR-002 forbids.
//
// WHY URL SCOPING IS MANDATORY: ESPN's commons bundle opens a second, unrelated
// WebSocket on the same page (four of them in the US1 capture, to
// espn.connections.edge.bamgrid.com). Wrapping unscoped would relay its traffic
// (FR-006) and feed its JSON to the draft classifier, firing FR-017a's
// unrecognised counter continuously.

export type Transport = "ws" | "sse";

export interface InterceptHooks {
  /** Called for each frame on a DRAFT channel only. Must never throw. */
  onFrame(raw: string, transport: Transport, url: string): void;
  /** Called when a draft channel opens or closes. */
  onChannel?(event: "open" | "close", transport: Transport, url: string): void;
  /** Called when the wrapper itself fails. Drives FR-017's loud reporting. */
  onError?(message: string): void;
  /** Decides whether a constructor URL is the draft channel. */
  isDraftChannel(url: string): boolean;
  /** Deferred so decode work never sits on ESPN's critical path. setTimeout,
   *  NOT queueMicrotask — microtasks drain before the event loop yields. */
  defer?(fn: () => void): void;
}

interface GlobalLike {
  WebSocket?: unknown;
  EventSource?: unknown;
  EventTarget?: { prototype: { addEventListener: EventTarget["addEventListener"] } };
}

const IS_WRAPPED = Symbol.for("draft-genie.tap.wrapped");

/** Was this global already wrapped? Re-wrapping would double-report frames. */
export function isWrapped(ctor: unknown): boolean {
  return typeof ctor === "function" && (ctor as unknown as Record<symbol, unknown>)[IS_WRAPPED] === true;
}

export function wrapConstructor<T extends abstract new (...a: never[]) => unknown>(
  Native: T,
  transport: Transport,
  hooks: InterceptHooks,
  addEventListener: EventTarget["addEventListener"],
): T {
  if (isWrapped(Native)) return Native;
  const defer = hooks.defer ?? ((fn: () => void) => setTimeout(fn, 0));

  const proxy = new Proxy(Native, {
    construct(target, args, newTarget) {
      // Construct FIRST and unconditionally: whatever happens in our own code,
      // the page gets a real, correctly-subclassed instance.
      const instance = Reflect.construct(target, args as never[], newTarget) as EventTarget;
      try {
        const url = String(args[0] ?? "");
        if (!hooks.isDraftChannel(url)) return instance;

        addEventListener.call(instance, "message", (ev: Event) => {
          const data = (ev as MessageEvent).data;
          defer(() => {
            try {
              if (typeof data === "string") hooks.onFrame(data, transport, url);
            } catch (e) {
              hooks.onError?.(`frame handler: ${(e as Error).message}`);
            }
          });
        });
        for (const kind of ["open", "close"] as const) {
          addEventListener.call(instance, kind, () => {
            try {
              hooks.onChannel?.(kind, transport, url);
            } catch { /* observation must never disturb the page */ }
          });
        }
      } catch (e) {
        // A throw anywhere in this trap propagates into the page's `new` and
        // would trigger ESPN's own fallback path. Swallow, report, carry on.
        try {
          hooks.onError?.(`wrapper: ${(e as Error).message}`);
        } catch { /* give up quietly rather than break the draft */ }
      }
      return instance;
    },
    get(target, prop, receiver) {
      if (prop === IS_WRAPPED) return true;
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy;
}

export interface InstallResult {
  wrapped: Transport[];
  /** False when the global we wrapped is not the page's — in an isolated world
   *  we would observe nothing while appearing perfectly healthy. */
  pageWorld: boolean;
}

export function install(scope: GlobalLike, hooks: InterceptHooks): InstallResult {
  const addEL = scope.EventTarget?.prototype.addEventListener;
  if (!addEL) {
    hooks.onError?.("no EventTarget in scope — cannot observe");
    return { wrapped: [], pageWorld: false };
  }
  const wrapped: Transport[] = [];
  for (const [name, transport] of [
    ["WebSocket", "ws"],
    ["EventSource", "sse"],
  ] as const) {
    const native = scope[name];
    if (typeof native !== "function") continue;
    try {
      const proxy = wrapConstructor(native as never, transport, hooks, addEL);
      (scope as Record<string, unknown>)[name] = proxy;
      if (isWrapped((scope as Record<string, unknown>)[name])) wrapped.push(transport);
    } catch (e) {
      hooks.onError?.(`install ${name}: ${(e as Error).message}`);
    }
  }
  return { wrapped, pageWorld: wrapped.length > 0 };
}
