// 010 T049 (static half) — Constitution VI, asserted against the SHIPPED
// artifact rather than the source, so a build-time regression cannot slip past.
//
// The other half — running a draft with all egress blocked except Draft Genie's
// ingest — needs a live draft and is recorded in quickstart.md scenario 2.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bundle = readFileSync("web/public/draft-tap.user.js", "utf8");

describe("shipped userscript is passive (FR-001 / SC-003)", () => {
  it("never constructs a socket of its own", () => {
    // It wraps the page's constructors; it must never call them.
    expect(bundle).not.toMatch(/new\s+(WebSocket|EventSource)\s*\(/);
  });

  it("has exactly one outbound destination, and it is Draft Genie", () => {
    const urls = bundle.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
    const hosts = new Set(urls.map((u) => new URL(u).hostname));
    // fantasy.espn.com appears only as a URL-parsing base and in @match; no
    // request is issued to it. Assert on the request call sites instead.
    const requestSites = bundle.match(/GM_xmlhttpRequest\s*\(\s*\{[\s\S]{0,400}?url:\s*[^,]+/g) ?? [];
    expect(requestSites.length).toBeGreaterThan(0);
    for (const site of requestSites) {
      expect(site).toMatch(/INGEST_ORIGIN|draft\.neelamjai\.com/);
      expect(site).not.toMatch(/espn/i);
    }
    expect(hosts.has("draft.neelamjai.com")).toBe(true);
  });

  it("issues no fetch or XHR at all", () => {
    expect(bundle).not.toMatch(/\bfetch\s*\(/);
    expect(bundle).not.toMatch(/XMLHttpRequest/);
  });

  it("never sends on a socket it observes", () => {
    expect(bundle).not.toMatch(/\.send\s*\(/);
  });

  it("carries the metadata banner with a narrow @connect and no @require", () => {
    expect(bundle).toMatch(/@connect\s+draft\.neelamjai\.com/);
    expect(bundle).not.toMatch(/@connect\s+\*/);
    expect(bundle).not.toMatch(/@require/);
    expect(bundle).toMatch(/@run-at\s+document-start/);
  });

  it("reports a version that matches the code it ships", () => {
    const banner = /@version\s+(\S+)/.exec(bundle)![1];
    expect(bundle).toContain(`"${banner}"`);
  });
});
