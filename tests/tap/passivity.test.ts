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

// 010 — T033's credential rule, asserted against the shipped artifact.
//
// "No function the page can reach may close over the pairing token." The
// pairing command broke that literally: under `@sandbox raw` + `@inject-into
// page` there is no second realm, so `W.prompt` IS `window.prompt` inside
// ESPN's JS, and any script on the page could replace it and read the bearer
// token as the owner typed it.
describe("the pairing token never passes through a page-replaceable function", () => {
  it("never reads prompt or alert off the global at a call site", () => {
    // Every use must go through the reference captured at document-start.
    expect(bundle).not.toMatch(/\b(?:W|window|unsafeWindow|globalThis)\s*\.\s*(?:prompt|alert)\s*\(/);
  });

  it("captures those natives up front and verifies they are native", () => {
    expect(bundle).toMatch(/captureNative|\[native code\]/);
    expect(bundle).toMatch(/Function\.prototype\.toString/);
  });

  it("refuses rather than falling back when prompt has been replaced", () => {
    // The failure mode must be "no pairing", never "pair through whatever the
    // page installed" — a token is not revocable by the person who typed it.
    expect(bundle).toMatch(/prompt\(\) was replaced|cannot accept a token/);
  });

  it("keeps the token out of the DOM and out of page-visible storage", () => {
    expect(bundle).not.toMatch(/localStorage|sessionStorage/);
    expect(bundle).not.toMatch(/dg:token["']?\s*\)?\s*[,)]?\s*;?\s*(?:W|window)\./);
  });
});

// 010 — the heartbeat must actually be wired, not merely defined (005 FR-007e).
describe("the shipped tap reports liveness on a timer", () => {
  it("schedules a periodic heartbeat", () => {
    expect(bundle).toMatch(/setInterval\(\s*\(\)\s*=>\s*heartbeat\(/);
  });

  it("also heartbeats on the wake events, which a throttled tab depends on", () => {
    // A hidden tab's timers stretch to ~1/minute; without these a wake-up is
    // invisible to the receiver for up to that long.
    expect(bundle).toMatch(/visibilitychange/);
    expect(bundle).toMatch(/heartbeat\(\s*true\s*\)/);
  });

  it("reports its own visibility, which the receiver cannot observe", () => {
    // Load-bearing: one lapse threshold applied to a throttled tab declares a
    // healthy tap dead, during the hour that mistake costs the most.
    expect(bundle).toMatch(/hidden:/);
  });

  it("still sends status when the state has NOT changed", () => {
    // The whole defect: reportStatus returns early on an unchanged state, so a
    // healthy tap was silent. The heartbeat must not go through that gate.
    //
    // Sliced between stable declaration anchors rather than matched with a
    // balanced-brace regex, which cannot be written correctly and silently
    // matched an empty string when it failed.
    const between = (from: string, to: string) => {
      const a = bundle.indexOf(from);
      const b = bundle.indexOf(to, a + 1);
      expect(a, `${from} not found in bundle`).toBeGreaterThan(-1);
      expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
      return bundle.slice(a, b);
    };

    const reportStatus = between("function reportStatus(", "function heartbeat(");
    expect(reportStatus).toMatch(/lastReportedState/); // the change gate lives here

    const heartbeat = between("function heartbeat(", "function postStatus(");
    expect(heartbeat).not.toMatch(/lastReportedState/); // ...and NOT here
    expect(heartbeat).toMatch(/postStatus\(/);
  });
});
