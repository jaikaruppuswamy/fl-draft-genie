// 011 T066 (FR-040) — the engine did not change, and structurally cannot drift
// into the feature that surrounds it.
//
// Constitution Principle IV: the recommendation engine is pure and independent.
// 011 added league-wide delivery, a credential handshake, a reset path and a
// replay lab, and none of it belongs anywhere near the engine. Across the whole
// feature `git diff -- src/engine/` is empty — verified, and recorded in
// ROADMAP.md.
//
// WHAT THIS FILE ASSERTS IS THE DURABLE HALF. A hash of the directory would
// pin "unchanged" exactly once and then fail confusingly on the first
// legitimate engine change in some later feature — a trap, not a guard. The
// property actually worth protecting is the DIRECTION OF DEPENDENCY: the engine
// may not learn about drafts, taps, sessions, HTTP or the lab. Keep that true
// and the engine cannot be dragged into a feature by accident; break it and the
// purity Principle IV asserts is already gone, whatever the diff says.
//
// 008 asserted its equivalent this way rather than trusting it, and found the
// lab reachable from the Worker entry point when nobody expected it to be.

import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Options written out at the call site — Vite parses the literal, and hoisting
// it into a const fails the build. Confirmed the hard way in 008.
const engineSources = import.meta.glob("../../src/engine/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/**
 * Import specifiers that survive to RUNTIME.
 *
 * `import type` is excluded deliberately, and the distinction is the whole
 * point rather than a loophole: a type erases at compile time, so
 * `import type { RosterSnapshot } from "../espn/parsers"` creates no dependency
 * on ESPN at all — it borrows a shape. Banning it would force the engine to
 * duplicate every type it consumes, which makes drift more likely, not less.
 */
function runtimeImports(source: string): string[] {
  return [...code(source).matchAll(/(?<!\btype\s)from\s+["']([^"']+)["']/g)]
    .filter((m) => !/import\s+type\b[^;]*$/.test(code(source).slice(0, m.index)))
    .map((m) => m[1]!);
}

describe("the engine has sources to check", () => {
  it("found them", () => {
    // Without this every assertion below passes vacuously on an empty glob —
    // the failure mode 006's mutation sweep hit when 10 of 102 tests ran.
    expect(Object.keys(engineSources).length).toBeGreaterThan(5);
  });
});

describe("the engine knows nothing about the feature around it (Principle IV)", () => {
  // Each of these would be a plausible shortcut and each would end the engine's
  // independence: reading a session to know what has been picked, calling the
  // ingest, reaching for a Durable Object, importing the lab that replays it.
  const banned = [
    { dir: "api", why: "HTTP — an engine that knows about requests cannot be replayed offline" },
    { dir: "db", why: "storage — 008's replay depends on the engine being a pure function of its inputs" },
    { dir: "lab", why: "the thing that replays it; the dependency would be a cycle" },
    { dir: "sync", why: "ESPN refresh — the engine never fetches, it is handed a snapshot" },
  ];

  for (const { dir, why } of banned) {
    it(`imports nothing from src/${dir}/ at runtime — ${why}`, () => {
      const offenders = Object.entries(engineSources)
        .filter(([, src]) =>
          runtimeImports(src).some((spec) => spec.includes(`/${dir}/`) || spec.startsWith(`../${dir}/`)),
        )
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  }

  it("takes DRAFT ARITHMETIC but never live draft STATE", () => {
    // The nuanced one, and worth stating rather than banning wholesale. The
    // engine legitimately imports `../draft/snake` — whose turn is it, how many
    // picks until mine — which is pure arithmetic over an order and a count,
    // and is exactly the kind of thing an engine should share rather than
    // reimplement.
    //
    // What it must never import is the modules that hold what has HAPPENED:
    // reconcile (the board), session (the Durable Object), feed (the frames),
    // liveness (whether a tap is alive). Those make the engine an observer, and
    // an observer cannot be replayed.
    const stateful = ["reconcile", "session", "feed", "liveness", "arming", "fingerprint"];
    for (const [path, src] of Object.entries(engineSources)) {
      for (const spec of runtimeImports(src)) {
        if (!spec.includes("draft/")) continue;
        const mod = spec.split("/").pop()!;
        expect(stateful, `${path} imports ${spec}`).not.toContain(mod);
      }
    }
  });

  it("reaches for no runtime the engine should not have", () => {
    // A pure scorer needs none of these. Any one of them means it has started
    // doing its own I/O, which is what makes a result irreproducible.
    for (const [path, src] of Object.entries(engineSources)) {
      expect(code(src), path).not.toMatch(/\bfetch\s*\(|DurableObject|D1Database|crypto\.subtle/);
    }
  });

  it("PROVES these checks can fail", () => {
    // A guard that cannot fire is decoration — the companion 007 shipped SC-003
    // without, and 011 has been adding ever since.
    const bad = 'import { getSession } from "../db/draft";\nconst r = await fetch("/x");';
    expect(runtimeImports(bad).some((s) => s.startsWith("../db/"))).toBe(true);
    expect(code(bad)).toMatch(/\bfetch\s*\(/);
    // ...and a type-only import must NOT trip it, or the rule bans borrowing a
    // shape, which is not what it is for.
    const fine = 'import type { RosterSnapshot } from "../espn/parsers";';
    expect(runtimeImports(fine)).toEqual([]);
  });
});
