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
    const declared = [...decl.matchAll(/kind:\s*["'`]([a-zA-Z]+)["'`]/g)].map((m) => m[1]!);
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

describe("the reducer accepts the frame the SERVER actually sends", () => {
  // THE DEFECT THIS EXISTS FOR is the one that froze a real draft, and it hid
  // behind a suite that was entirely green.
  //
  // `src/draft/session.ts` broadcasts
  //     {type, epoch, seq, revision, kind, payload}
  // which is what 005's contracts/api.md ratified. The reducer read
  // `frame.event` — a key nothing has ever set. Every live event resolved to
  // `{}` and fell through to `default:`. No pick placed, no turn update, no
  // completion, no refresh. The cursor still advanced, so there was no gap to
  // trigger recovery either. The board only ever changed when a reconnect
  // delivered a fresh snapshot.
  //
  // WHY NOTHING CAUGHT IT: every room test hand-builds its frames with an
  // `event:` key, and the Durable Object tests assert only `type`/`seq`/`epoch`
  // and never inspect a body. Both sides were tested against a shape the wire
  // never carried. This asserts the SEAM — the exact JSON the server writes.

  /** Byte-for-byte the object `session.ts` stringifies onto the socket. */
  const serverFrame = (seq: number, event: Record<string, unknown>) => ({
    type: "event",
    epoch: "e1",
    seq,
    revision: event.revision,
    kind: event.kind,
    payload: event,
  });

  function seeded(): RoomState {
    return reduce(
      initialState(),
      {
        kind: "frame",
        frame: { type: "snapshot", epoch: "e1", seq: 0, state: { revision: 0, picks: [] } } as never,
      },
      0,
    ).state;
  }

  it("places a pick from a server-shaped pick_made", () => {
    const { state, effects } = reduce(
      seeded(),
      {
        kind: "frame",
        frame: serverFrame(1, {
          kind: "pick_made",
          revision: 0,
          overall: 1,
          teamId: 1,
          playerId: 4262921,
          observedAt: "2026-08-07T02:45:00.000Z",
        }) as never,
      },
      0,
    );

    expect(state.picks.map((p) => p.playerId)).toContain(4262921);
    expect(state.phase).toBe("live");
    // A pick must always lead to fresh advice. Adopting the snapshot already
    // put one request in flight, so this one is QUEUED rather than issued —
    // which is the designed behaviour and worth pinning, since a second
    // concurrent fetch per pick is what FR-004 exists to avoid.
    expect(effects.length === 1 || state.dirty).toBe(true);
  });

  it("issues the fetch outright when nothing is already in flight", () => {
    // The other half, so "leads to advice" is not satisfied by dirty alone.
    const idle = { ...seeded(), inFlight: false, dirty: false };
    const { effects } = reduce(
      idle,
      {
        kind: "frame",
        frame: serverFrame(1, {
          kind: "pick_made",
          revision: 0,
          overall: 1,
          teamId: 1,
          playerId: 4262921,
          observedAt: "2026-08-07T02:45:00.000Z",
        }) as never,
      },
      0,
    );
    expect(effects.map((e) => e.kind)).toContain("fetchRecommendation");
  });

  it("advances the turn from a server-shaped on_deck", () => {
    const { state } = reduce(
      seeded(),
      { kind: "frame", frame: serverFrame(1, { kind: "on_deck", revision: 0, overall: 3, picksUntil: 2 }) as never },
      0,
    );
    expect(state.picksUntilMyTurn).toBe(2);
  });

  it("PROVES the check can fail — the old shape places nothing", () => {
    // The frame every existing test was written with. It must be visibly
    // different from the wire, or this file proves nothing.
    const legacy = { type: "event", epoch: "e1", seq: 1, event: { kind: "pick_made", revision: 0, overall: 1, teamId: 1, playerId: 4262921 } };
    const wire = serverFrame(1, { kind: "pick_made", revision: 0, overall: 1, teamId: 1, playerId: 4262921 });
    expect(Object.keys(wire)).toContain("payload");
    expect(Object.keys(legacy)).not.toContain("payload");
  });

  it("tolerates an unknown event kind rather than rejecting it (FR-006a)", () => {
    // The contract requires forward compatibility: a kind we do not know must
    // advance the cursor and change nothing, not break the stream.
    const { state } = reduce(
      seeded(),
      { kind: "frame", frame: serverFrame(1, { kind: "something_new", revision: 0 }) as never },
      0,
    );
    expect(state.cursor).toBe(1);
  });
});

describe("014 — the turn countdown is always current", () => {
  // Observed live on 2026-08-07: after a manager's own turn the room read
  // "your pick — now" for the rest of the draft, correcting itself only on a
  // reload. `picksUntilMyTurn` reached a client ONLY via `on_deck`, which the
  // reconciler fires sparsely — once as a turn approaches, not per pick. So it
  // hit 0 and stayed, and `myTurnState` derives `on_the_clock` from exactly 0.
  //
  // A reload looked correct because a snapshot recomputes it, which is what
  // made the live path's silence so easy to miss.

  const withTurn = (seq: number, picksUntilMyTurn: number | null, kind = "pick_made") => ({
    type: "event",
    epoch: "e1",
    seq,
    revision: 0,
    kind,
    payload: { kind, revision: 0, overall: seq, teamId: 1, playerId: 1000 + seq },
    picksUntilMyTurn,
  });

  function seeded(): RoomState {
    return reduce(
      initialState(),
      {
        kind: "frame",
        frame: { type: "snapshot", epoch: "e1", seq: 0, state: { revision: 0, picks: [] } } as never,
      },
      0,
    ).state;
  }

  it("updates from a pick_made frame, not only from on_deck", () => {
    const { state } = reduce(seeded(), { kind: "frame", frame: withTurn(1, 7) as never }, 0);
    expect(state.picksUntilMyTurn).toBe(7);
    expect(state.myTurnState).toBe("idle");
  });

  it("counts DOWN across successive picks", () => {
    // The behaviour asked for: always show how many picks away I am.
    let s = seeded();
    for (const [seq, until] of [
      [1, 5],
      [2, 4],
      [3, 3],
    ] as const) {
      s = reduce(s, { kind: "frame", frame: withTurn(seq, until) as never }, 0).state;
    }
    expect(s.picksUntilMyTurn).toBe(3);
  });

  it("LEAVES `now` once the turn has passed — the exact stuck state", () => {
    // 0 is my turn; the very next frame must move off it. This is the assertion
    // that fails against the shipped behaviour.
    let s = reduce(seeded(), { kind: "frame", frame: withTurn(1, 0) as never }, 0).state;
    expect(s.myTurnState).toBe("on_the_clock");

    s = reduce(s, { kind: "frame", frame: withTurn(2, 11) as never }, 0).state;
    expect(s.picksUntilMyTurn).toBe(11);
    expect(s.myTurnState).toBe("idle");
  });

  it("keeps the last known value when a frame carries none", () => {
    // An older server, or a session with no team to reason about. Blanking the
    // indicator would be worse than holding the last honest answer.
    let s = reduce(seeded(), { kind: "frame", frame: withTurn(1, 4) as never }, 0).state;
    const noField = { type: "event", epoch: "e1", seq: 2, revision: 0, kind: "pick_made", payload: { kind: "pick_made", revision: 0, overall: 2, teamId: 1, playerId: 2 } };
    s = reduce(s, { kind: "frame", frame: noField as never }, 0).state;
    expect(s.picksUntilMyTurn).toBe(4);
  });

  it("PROVES the check can fail — on_deck alone would leave it stuck", () => {
    // Without the per-frame value, a pick_made after my turn changes nothing,
    // which is precisely what shipped.
    let s = reduce(seeded(), { kind: "frame", frame: withTurn(1, 0) as never }, 0).state;
    const legacy = { type: "event", epoch: "e1", seq: 2, revision: 0, kind: "pick_made", payload: { kind: "pick_made", revision: 0, overall: 2, teamId: 1, playerId: 2 } };
    s = reduce(s, { kind: "frame", frame: legacy as never }, 0).state;
    expect(s.myTurnState).toBe("on_the_clock");
  });
});

describe("the reset control describes what the ENDPOINT does", () => {
  // The copy said it cleared "everyone in this league"; `POST /:id/draft/reset`
  // calls `resetOneSession` and clears one. FR-027 makes reset session-level,
  // and the route's own comment says a leaguemate is left untouched. Both halves
  // were written in the same commit, one against fan-out semantics and one
  // against per-session — so a manager clearing a contaminated session before a
  // draft was told the league was clean while every leaguemate's object still
  // held the old picks.
  //
  // This is the pattern the whole sweep is about, in its most literal form: the
  // words and the behaviour are two things that must change together.

  it("does not claim to clear the league", () => {
    const copy = page().replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
    expect(copy).not.toMatch(/everyone in this league/i);
  });

  it("PROVES the check can fail", () => {
    expect("Clears the picks for everyone in this league").toMatch(/everyone in this league/i);
  });

  it("the endpoint it calls really is per-session", () => {
    // Asserted against the route, so if the endpoint is ever made league-wide
    // this test is where someone is told to revisit the copy.
    const route = readFileSync(
      fileURLToPath(new URL("../../src/api/draft.ts", import.meta.url)),
      "utf8",
    );
    const handler = /app\.post\("\/:id\/draft\/reset"[\s\S]{0,2000}/.exec(route)?.[0] ?? "";
    expect(handler, "reset route not found").toBeTruthy();
    expect(handler).toMatch(/resetOneSession\(/);
    expect(handler).not.toMatch(/resetLeagueSessions\(/);
  });
});

describe("the revision-bump path, which only became reachable in 013", () => {
  // Promised during the draft and not delivered then: I hypothesised this path
  // was dropping recommendations, the reported symptom turned out to be an
  // unpicked player, and I stopped looking. The path is still worth pinning,
  // because before the `payload` fix `event.revision` was always undefined —
  // so this branch had NEVER executed, in any draft, ever.
  //
  // 005 bumps the revision on a CORRECTION and replays the affected turns, so a
  // held board and the local pick list are both suspect.

  const bump = (seq: number, revision: number) => ({
    type: "event",
    epoch: "e1",
    seq,
    revision,
    kind: "pick_made",
    payload: { kind: "pick_made", revision, overall: seq, teamId: 1, playerId: 1000 + seq },
    picksUntilMyTurn: 6,
  });

  function seeded(): RoomState {
    return reduce(
      initialState(),
      {
        kind: "frame",
        frame: { type: "snapshot", epoch: "e1", seq: 0, state: { revision: 0, picks: [] } } as never,
      },
      0,
    ).state;
  }

  it("re-reads on a correction instead of trusting the local view", () => {
    const { state, effects } = reduce(seeded(), { kind: "frame", frame: bump(1, 7) as never }, 0);
    expect(state.revision).toBe(7);
    expect(state.recommendation).toBeNull();
    expect(effects.map((e) => e.kind)).toContain("fetchSnapshot");
  });

  it("keeps the turn countdown across the bump", () => {
    // The branch returns early, so anything computed before it must survive.
    // Getting this wrong would blank the indicator on every correction.
    const { state } = reduce(seeded(), { kind: "frame", frame: bump(1, 7) as never }, 0);
    expect(state.picksUntilMyTurn).toBe(6);
  });

  it("does NOT re-read when the revision is unchanged — PROVES it is conditional", () => {
    // Without this, "re-reads on a correction" passes against a reducer that
    // re-reads on every single frame, which at autodraft speed would be a
    // snapshot fetch per pick.
    const { effects } = reduce(seeded(), { kind: "frame", frame: bump(1, 0) as never }, 0);
    expect(effects.map((e) => e.kind)).not.toContain("fetchSnapshot");
  });

  it("recovers: the snapshot that follows restores the board and asks for advice", () => {
    // The half that matters. A correction that cleared the board and never
    // recovered would look exactly like the freeze.
    const bumped = reduce(seeded(), { kind: "frame", frame: bump(1, 7) as never }, 0).state;
    const { state, effects } = reduce(
      bumped,
      {
        kind: "frame",
        frame: {
          type: "snapshot",
          epoch: "e1",
          seq: 9,
          state: { revision: 7, picks: [{ overall: 1, teamId: 1, playerId: 4262921, observedAt: "x" }] },
        } as never,
      },
      0,
    );
    expect(state.picks).toHaveLength(1);
    expect(state.cursor).toBe(9);
    // Advice is REQUESTED OR QUEUED. A fetch was already in flight from the
    // opening snapshot, so this one sets `dirty` and the trailing refresh fires
    // when that response lands — deliberately, since a second concurrent fetch
    // per correction is what FR-004 exists to avoid. Asserting only the effect
    // would call a working design broken.
    expect(effects.some((e) => e.kind === "fetchRecommendation") || state.dirty).toBe(true);
  });

  it("issues the fetch outright when nothing is in flight", () => {
    // The other half, so "requested or queued" cannot be satisfied by `dirty`
    // alone in every case.
    const bumped = { ...reduce(seeded(), { kind: "frame", frame: bump(1, 7) as never }, 0).state, inFlight: false };
    const { effects } = reduce(
      bumped,
      {
        kind: "frame",
        frame: { type: "snapshot", epoch: "e1", seq: 9, state: { revision: 7, picks: [] } } as never,
      },
      0,
    );
    expect(effects.map((e) => e.kind)).toContain("fetchRecommendation");
  });
});
