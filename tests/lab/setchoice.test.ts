// 008 T010 — which set was serving, written before the function.

import { describe, expect, it } from "vitest";
import { chooseSetAt, type CandidateSet } from "../../src/lab/setChoice";

const set = (over: Partial<CandidateSet> & { id: string; fetched_at: string }): CandidateSet => ({
  status: "complete",
  season: 2026,
  ...over,
});

const SETS: CandidateSet[] = [
  set({ id: "aug02", fetched_at: "2026-08-02T06:00:00.000Z" }),
  set({ id: "aug03", fetched_at: "2026-08-03T06:00:00.000Z" }),
  set({ id: "aug04-morning", fetched_at: "2026-08-04T13:00:00.000Z" }),
  set({ id: "aug05", fetched_at: "2026-08-05T06:00:00.000Z" }),
];

describe("chooseSetAt", () => {
  it("picks the newest complete set at or before the draft", () => {
    // A draft at 23:00 on the 4th was ranked against that morning's top-up,
    // not against the set published the next day.
    expect(chooseSetAt(SETS, "2026-08-04T23:00:00.000Z")?.id).toBe("aug04-morning");
  });

  it("picks a set fetched at exactly the draft's start time", () => {
    expect(chooseSetAt(SETS, "2026-08-04T13:00:00.000Z")?.id).toBe("aug04-morning");
  });

  it("returns null when no set predates the draft — never the nearest one", () => {
    // THE assertion that keeps a replay honest. A board published after a draft
    // already reflects what happened in it, so ranking that draft against it is
    // a different question wearing the right answer's clothes.
    expect(chooseSetAt(SETS, "2026-08-01T00:00:00.000Z")).toBeNull();
  });

  it("ignores building sets", () => {
    // 002 publishes atomically; a half-ingested board never served anyone.
    const withBuilding = [...SETS, set({ id: "partial", fetched_at: "2026-08-04T20:00:00.000Z", status: "building" })];
    expect(chooseSetAt(withBuilding, "2026-08-04T23:00:00.000Z")?.id).toBe("aug04-morning");
  });

  it("returns null for an unknown start time rather than guessing", () => {
    expect(chooseSetAt(SETS, null)).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    // The 2024 case: the pipeline never ran, so no set exists at any time.
    expect(chooseSetAt([], "2024-08-25T00:00:00.000Z")).toBeNull();
  });

  it("does not depend on the order rows arrive in", () => {
    const shuffled = [SETS[3]!, SETS[0]!, SETS[2]!, SETS[1]!];
    expect(chooseSetAt(shuffled, "2026-08-04T23:00:00.000Z")?.id).toBe("aug04-morning");
  });

  it("is deterministic", () => {
    const a = chooseSetAt(SETS, "2026-08-04T23:00:00.000Z");
    const b = chooseSetAt(SETS, "2026-08-04T23:00:00.000Z");
    expect(a?.id).toBe(b?.id);
  });
});
