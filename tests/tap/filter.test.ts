// 010 T017/T019 — the privacy allowlist and the verb classifier, tested against
// the real capture. Field 4 of SELECTED is a member SWID, so these are the
// control that keeps leaguemates' identifiers off the wire.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, isDraftChannel, normalise, KNOWN_NON_DRAFT, safeVerb } from "../../tap/classify";
import { assertTransmittable, filterPickFields } from "../../tap/filter";

const frames = readFileSync("tests/fixtures/tap/capture-2026.jsonl", "utf8")
  .trim().split("\n").map((l) => JSON.parse(l) as { data?: string; url?: string; event?: string });

const selected = frames.filter((f) => f.data?.startsWith("SELECTED "));

describe("filterPickFields", () => {
  it("drops the member SWID in field 4", () => {
    const withSwid = selected.find((f) => f.data!.includes("{"))!;
    const c = classify(withSwid.data!);
    expect(c.kind).toBe("pick");
    const swid = /\{[0-9A-Fa-f-]+\}/.exec(withSwid.data!)![0];
    const out = filterPickFields((c as { fields: string[] }).fields)!;
    expect(JSON.stringify(out)).not.toContain(swid.replace(/[{}]/g, ""));
    expect(Object.keys(out).sort()).toEqual(["playerId", "slot3", "teamId"]);
  });

  it("keeps negative player ids (D/ST)", () => {
    const out = filterPickFields(["5", "-16007", "7"])!;
    expect(out.playerId).toBe(-16007);
  });

  it("passes every SELECTED frame in the capture without leaking a GUID", () => {
    expect(selected.length).toBeGreaterThan(60);
    for (const f of selected) {
      const c = classify(f.data!);
      const out = filterPickFields((c as { fields: string[] }).fields);
      expect(out).not.toBeNull();
      expect(() => assertTransmittable(out)).not.toThrow();
    }
  });

  it("rejects a malformed frame rather than emitting a partial pick", () => {
    expect(filterPickFields(["5"])).toBeNull();
    expect(filterPickFields(["5", "notanumber", "2"])).toBeNull();
  });
});

describe("assertTransmittable", () => {
  it("throws on a GUID", () => {
    expect(() => assertTransmittable({ x: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}" })).toThrow(/GUID/);
  });
  it("throws on a URL (location.href carries the owner's SWID)", () => {
    expect(() => assertTransmittable({ href: "https://fantasy.espn.com/football/draft?memberId=x" })).toThrow(/URL/);
  });
  it("passes a numeric payload", () => {
    expect(() => assertTransmittable({ teamId: 5, playerId: -16007, slot3: 7 })).not.toThrow();
  });
});

describe("classify", () => {
  it("recognises every verb in the capture as pick, ledger or known-non-draft", () => {
    const unrecognised = new Set<string>();
    for (const f of frames) {
      if (!f.data || f.event !== "message") continue;
      if (f.data.startsWith("{")) continue; // ESPN's other socket, excluded by URL scoping
      const c = classify(f.data);
      if (c.kind === "unrecognised") unrecognised.add(c.verb);
    }
    expect([...unrecognised]).toEqual([]);
  });

  it("reports an unknown verb rather than dropping it silently (FR-017a)", () => {
    expect(classify("WOMBAT 1 2 3\n")).toEqual({ kind: "unrecognised", verb: "WOMBAT" });
  });

  it("drops a KNOWN non-draft verb silently", () => {
    expect(classify("PONG\n").kind).toBe("known-non-draft");
    expect(KNOWN_NON_DRAFT.has("PONG")).toBe(true);
    // PING is client->server only; we never send, so it must not appear inbound.
    expect(KNOWN_NON_DRAFT.has("PING")).toBe(false);
  });

  it("normalises the WS trailing newline that SSE frames lack", () => {
    expect(normalise("SELECTED 1 2 3\n")).toBe("SELECTED 1 2 3");
    expect(normalise("SELECTED 1 2 3")).toBe("SELECTED 1 2 3");
  });
});

describe("isDraftChannel", () => {
  it("accepts the draft socket and rejects ESPN's second socket", () => {
    const draft = frames.find((f) => f.url?.includes("fantasydraft"))!.url!;
    const other = frames.find((f) => f.url?.includes("bamgrid"))!.url!;
    expect(isDraftChannel(draft)).toBe(true);
    expect(isDraftChannel(other)).toBe(false);
  });

  it("rejects anything else, including junk", () => {
    expect(isDraftChannel("https://fantasy.espn.com/x")).toBe(false);
    expect(isDraftChannel("not a url")).toBe(false);
  });
});

describe("unrecognised verbs never carry free text (FR-006a)", () => {
  it("passes a real verb through, so FR-017a stays diagnostic", () => {
    expect(safeVerb("AUTOSUGGEST")).toBe("AUTOSUGGEST");
    expect(safeVerb("SELECTING")).toBe("SELECTING");
    expect(classify("BRANDNEWVERB 1 2\n")).toMatchObject({ kind: "unrecognised", verb: "BRANDNEWVERB" });
  });

  it("replaces anything NOT verb-shaped with its shape alone", () => {
    // The old code relayed `verb.slice(0, 32)` — raw wire text, which FR-006a
    // forbids outright.
    expect(safeVerb('{"type":"presence","user":"someone"}')).toMatch(/^<non-verb:\d+>$/);
    expect(safeVerb("hello world")).toMatch(/^<non-verb:\d+>$/);
  });

  it("cannot emit a TRUNCATED identifier, which defeated every downstream guard", () => {
    // 32 < 36, so a SWID in the leading token used to arrive clipped — and
    // assertTransmittable, the ingest boundary check and the privacy sweep all
    // match only a COMPLETE GUID. Truncation disabled the controls meant to
    // catch exactly this.
    const swid = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";
    const out = safeVerb(swid);
    expect(out).toMatch(/^<non-verb:\d+>$/);
    expect(out).not.toContain("AAAAAAAA");
    // And the old behaviour would have produced something no guard would catch:
    expect(swid.slice(0, 32)).toContain("AAAAAAAA");
    expect(() => assertTransmittable({ verb: swid.slice(0, 32) })).not.toThrow(); // the gap, demonstrated
    expect(() => assertTransmittable({ verb: out })).not.toThrow();
  });

  it("survives the whole committed corpus without emitting free text", () => {
    for (const f of frames) {
      const line = f.data;
      if (typeof line !== "string") continue;
      const c = classify(line);
      if (c.kind !== "unrecognised") continue;
      expect(c.verb).toMatch(/^([A-Z][A-Z0-9_]{0,23}|<non-verb:\d+>)$/);
    }
  });
});
