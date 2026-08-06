// 008 T013 — Constitution VI, guarded rather than promised.
//
// "Observation is not participation. Draft Genie MUST NOT open a connection to
// ESPN's draft room, transmit any message on that channel, or take any action
// that registers it as a participant in a draft."
//
// The lab reads a draft that FINISHED. Nothing about that needs a socket, and
// nothing about it needs a write. But the principle is a MUST and it had no
// guard here — `/speckit-analyze` caught the omission — so this asserts it the
// way 010 does for the shipped userscript, by reading the source rather than
// trusting it.
//
// The realistic failure is not malice. It is someone reaching for a live feed
// to "make the corpus fresher" and discovering, on draft day, that a second
// session evicted the owner from their own draft room.

import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Options written out at each call site — Vite parses the literal, and hoisting
// it into a const fails the build. See the same note in boundary.test.ts.
const sources = {
  ...import.meta.glob("../../src/lab/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../scripts/lab-*.ts", { query: "?raw", import: "default", eager: true }),
};

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/**
 * Comments and QUOTED strings stripped — but template literals kept.
 *
 * The distinction is the whole point for the credential check below. A leaked
 * credential arrives as an identifier or an interpolation
 * (`console.log(process.env.ESPN_S2)`, `` console.log(`${swid}`) ``), never as
 * a quoted word. Meanwhile a usage line legitimately contains the literal text
 * `ESPN_S2='...'`, which names the variable and reveals nothing — and scanning
 * raw source flagged exactly that, in this feature's own Gate 0 script.
 *
 * The mirror-image mistake is in `boundary.test.ts`: an HTTP verb IS a quoted
 * literal, so that check scans raw. Neither rule generalises; each is chosen
 * for what it is looking for.
 */
function codeKeepingTemplates(source: string): string {
  return code(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe("the lab never joins a draft room (Constitution VI, FR-033)", () => {
  it("has sources to check", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  const FORBIDDEN: [RegExp, string][] = [
    [/\bnew\s+WebSocket\b/, "a draft-room connection registers a participant"],
    [/\bWebSocketPair\b/, "same"],
    [/\bnew\s+EventSource\b/, "a live stream is still a connection"],
    [/\bwss?:\/\//, "no draft-room URL belongs in the lab"],
    [/\blm-api-writes\b/, "ESPN is read-only to this product"],
  ];

  for (const [pattern, why] of FORBIDDEN) {
    it(`contains no ${pattern.source} — ${why}`, () => {
      const offenders = Object.entries(sources)
        .filter(([, s]) => pattern.test(code(s)))
        .map(([p]) => p);
      expect(offenders).toEqual([]);
    });
  }

  it("issues no non-GET request to ESPN", () => {
    // Scanned against RAW source, deliberately. An HTTP verb IS a string
    // literal, so stripping literals turns `method: "POST"` into `method: ""`
    // and the check can never fire — the exact bug 006's FR-020 guard shipped
    // with before it was caught.
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(sources)) {
      if (/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i.test(raw)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("proves the non-GET check can fail", () => {
    // With literals stripped this sample would read `method: ""` and pass,
    // which is precisely why the check above does not strip them.
    const sample = `await fetch(url, { method: "POST" });`;
    expect(/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i.test(sample)).toBe(true);
    const allowed = `await fetch(url, { method: "GET" });`;
    expect(/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i.test(allowed)).toBe(false);
  });
});

describe("ESPN credentials never leave the Cookie header (constitution)", () => {
  it("never places a cookie in a URL", () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(sources)) {
      // A credential in a query string is logged by every proxy in the path,
      // and ends up in shell history the moment someone re-runs the command.
      if (/[?&](espn_s2|swid)=/i.test(raw)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("never logs a credential value", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (/console\.[a-z]+\([^)]*\b(espnS2|swid|ESPN_S2|SWID)\b/i.test(codeKeepingTemplates(source))) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("proves the credential-logging check can fail, and tolerates a usage line", () => {
    const leakIdentifier = `console.log(process.env.ESPN_S2);`;
    const leakInterpolated = "console.log(`cookie ${swid}`);";
    const usage = `console.error("usage: ESPN_S2='...' SWID='{...}' npx tsx ...");`;
    const pattern = /console\.[a-z]+\([^)]*\b(espnS2|swid|ESPN_S2|SWID)\b/i;

    expect(pattern.test(codeKeepingTemplates(leakIdentifier))).toBe(true);
    expect(pattern.test(codeKeepingTemplates(leakInterpolated))).toBe(true);
    // Names the variable, reveals nothing. Scanning raw source flagged this.
    expect(pattern.test(codeKeepingTemplates(usage))).toBe(false);
  });
});
