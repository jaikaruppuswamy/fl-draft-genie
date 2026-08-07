// 013 — the recovery path has to actually recover.
//
// THE DEFECT THIS EXISTS FOR froze a real 72-pick draft in every browser.
//
// `reduceFrame` recovers from a missed frame exactly one way: on a forward gap
// it returns WITHOUT advancing the cursor and emits `{kind:"fetchSnapshot"}`,
// trusting the caller to re-seed it. The caller did fetch a snapshot — and
// dispatched it with `seq: 0` hardcoded. `applySnapshot` adopts a snapshot's seq
// as the cursor wholesale, so recovery rewound the cursor to the beginning. The
// next live event was then a forward gap, which fetched a snapshot, which
// rewound to 0 again.
//
// An infinite resync loop. The board froze on whatever the last snapshot said,
// applied no further events, and re-fetched on every frame for the rest of the
// draft. The server had always sent `seq` and the client type had always
// declared it; one line discarded it.
//
// WHY THE EXISTING TESTS ALL PASSED. The reducer is pure and well covered —
// `tests/room/recovery.test.ts` asserts a gap EMITS `fetchSnapshot`, and it
// faithfully does. Nobody asserted that acting on it RESTORES anything. Each
// side of the seam was tested alone and the seam was not, which is how a total
// failure of the product looked green.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initialState, reduce, type Effect, type RoomState } from "../../web/src/lib/draftRoom";

const PAGE = fileURLToPath(new URL("../../web/src/pages/DraftRoom.tsx", import.meta.url));

function page(): string {
  return readFileSync(PAGE, "utf8");
}

/** Every effect kind the reducer's type can express. */
const EFFECT_KINDS: Effect["kind"][] = ["fetchRecommendation", "fetchSnapshot"];

describe("every effect the reducer can emit is acted on", () => {
  it("has the page to read", () => {
    // Without this the assertions below pass vacuously on an empty read.
    expect(page().length).toBeGreaterThan(1000);
  });

  it("names every kind the union declares — a new effect cannot slip past", () => {
    // The closed-set half. Without it, adding a third effect gives it no test
    // and everything below keeps passing on the two it already knew about.
    const src = readFileSync(
      fileURLToPath(new URL("../../web/src/lib/draftRoom.ts", import.meta.url)),
      "utf8",
    );
    const decl = /export type Effect =([^;]+);/.exec(src)?.[1] ?? "";
    const declared = [...decl.matchAll(/kind:\s*["\'`]([a-zA-Z]+)["\'`]/g)].map((m) => m[1]!);
    expect(declared.sort()).toEqual([...EFFECT_KINDS].sort());
  });

  it("re-seeds the cursor from the SNAPSHOT'S OWN seq, never a constant", () => {
    // The bug, asserted on the source because it lives in the page's fetch
    // callback where no unit test reaches it. A literal `seq: 0` here is the
    // whole defect: recovery that rewinds the cursor is not recovery.
    const code = page().replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    const dispatchBlock = /getDraftSnapshot[\s\S]{0,500}/.exec(code)?.[0] ?? "";
    expect(dispatchBlock, "no snapshot fetch found").toBeTruthy();
    expect(dispatchBlock).not.toMatch(/seq:\s*0\b/);
    expect(dispatchBlock).toMatch(/seq:.*\bseq\b/);
  });

  it("PROVES that check can fail", () => {
    const bad = 'getDraftSnapshot(id).then((snap) => dispatch({ frame: { type: "snapshot", seq: 0, state: snap } }))';
    expect(bad).toMatch(/seq:\s*0\b/);
  });
});

describe("a forward gap must RECOVER, not merely intend to", () => {
  const frame = (seq: number, epoch = "e1") => ({
    type: "event" as const,
    epoch,
    seq,
    event: { kind: "pick_made", revision: 0, overall: seq, teamId: 1, playerId: 1000 + seq },
  });

  function seeded(): RoomState {
    // Adopt a snapshot so epoch and cursor are established, as a real client does.
    const { state } = reduce(
      initialState(),
      { kind: "frame", frame: { type: "snapshot", epoch: "e1", seq: 0, state: { revision: 0, picks: [] } } as never },
      0,
    );
    return state;
  }

  it("asks for a snapshot on a gap", () => {
    // The half that was already true and already tested.
    const { effects } = reduce(seeded(), { kind: "frame", frame: frame(5) as never }, 0);
    expect(effects.map((e) => e.kind)).toContain("fetchSnapshot");
  });

  it("leaves the cursor STUCK until something answers — which is why the answer must exist", () => {
    // This is the mechanism of the freeze, pinned so nobody "simplifies" the
    // gap branch into advancing the cursor and silently dropping picks instead.
    const before = seeded();
    const { state: after } = reduce(before, { kind: "frame", frame: frame(5) as never }, 0);
    expect(after.cursor).toBe(before.cursor);

    // And a SECOND gapped frame behaves identically — the board cannot heal on
    // its own, at any point, ever.
    const { state: third } = reduce(after, { kind: "frame", frame: frame(6) as never }, 0);
    expect(third.cursor).toBe(before.cursor);
    expect(third.picks).toHaveLength(0);
  });

  it("applies a contiguous frame normally — PROVES the gap branch is conditional", () => {
    // Without this, "a gap freezes" passes against a reducer that ignores every
    // frame, which would look identical from the outside.
    const { state } = reduce(seeded(), { kind: "frame", frame: frame(1) as never }, 0);
    expect(state.cursor).toBe(1);
    expect(state.picks.length).toBeGreaterThan(0);
  });
});
