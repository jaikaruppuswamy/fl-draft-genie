// 007 — the draft room's brain.
//
// PURE. No `fetch`, no `Date`, no DOM, no React. `tests/room/purity.test.ts`
// enforces that structurally, and `tests/room/replay-timing.test.ts` is only
// possible because of it.
//
// WHY A REDUCER AND NOT A COMPONENT. FR-024 requires SC-001 — "a recommendation
// is current before the owner's turn begins" — be measured OFFLINE. Rendering
// React headlessly to measure that would need jsdom, a component-testing
// library and a fourth vitest project… and it would measure the wrong thing.
// SC-001 cannot fail in a render. It fails by DECIDING TO FETCH TOO LATE, which
// is pure logic. So the logic lives here, `at` arrives as a parameter, and
// effects are DESCRIBED rather than performed — which makes the decision itself
// directly assertable.
//
// This is the third time the project has made this move: 005's `reconcile.ts`
// and 006's `recommend.ts` are the same shape, for the same reason.
//
// THE BOUNDARY WITH 005. This file applies pick events ADDITIVELY so the board
// updates instantly. It does NOT reconcile. Ordinals, ledger merges, pending vs
// confirmed — all of that stays server-side, where 005 fought for it (including
// a bug where the reducer silently deleted picks). Anything needing judgement
// re-reads the snapshot instead. The client displays; the server decides.

import type { DraftFrame } from "./draftSocket";

/** One placed pick. Enough to fill a grid cell — nothing more is derived here. */
export interface Pick {
  overall: number;
  teamId: number;
  playerId: number;
}

export type Reachability = "connected" | "reconnecting" | "polling";

export type TurnState = "idle" | "on_deck" | "on_the_clock";

export type Phase = "pre_draft" | "live" | "complete";

/** 006's board, carried verbatim. This file never recomputes a value. */
export interface RankedBoardLike {
  revision: number;
  withheld: { reason: string; detail: string } | null;
  forced: boolean;
  needs: { position: string; required: number; owned: number; unfilled: number }[];
  round_value: number;
  warnings: { kind: string; detail: string }[];
  shortlist: unknown[];
  entries: unknown[];
}

/**
 * Which route concluded the draft was over, and whether they agreed.
 *
 * NEITHER ROUTE IS LOAD-BEARING ALONE (FR-022a). The completion signal has
 * never fired in production — `draft_archives` holds zero rows, because the
 * draft length was 0 during the only live test, making completion unreachable —
 * and the pick count depends on that same length, which has been wrong before.
 * They fail differently, which is the whole point of requiring either.
 */
export interface Completion {
  by: "signal" | "pick_count" | "both";
  at: number;
  /** One route says complete, the other does not. Surfaced, never resolved. */
  divergent: boolean;
}

export interface RoomState {
  phase: Phase;
  picks: Pick[];
  revision: number;
  epoch: string | null;
  /** Last applied `seq`. Frames at or below are duplicates and are free. */
  cursor: number;
  onTheClock: number | null;
  /** NULL means UNKNOWN — never zero. A zero here reads as "you're up". */
  picksUntilMyTurn: number | null;
  myTeamId: number | null;
  myTurnState: TurnState;
  totalPicks: number;
  recommendation: RankedBoardLike | null;
  /** Which revision the held recommendation was computed for (FR-016). */
  recommendationRevision: number | null;
  inFlight: boolean;
  /** A pick landed while a request was outstanding — fetch once on return. */
  dirty: boolean;
  reachability: Reachability;
  /** 005's verdict. Distinct from `reachability` — different remedies. */
  withholding: { reason: string; detail: string } | null;
  completion: Completion | null;
  draftAt: string | null;
  /** NULL means ESPN has not published it. Never invented. */
  order: number[] | null;
}

export type RoomInput =
  /**
   * The screen opened. Fetches immediately, without waiting for a frame.
   *
   * WITHOUT THIS THE ROOM IS BLANK UNTIL THE FIRST PICK LANDS. Nothing else
   * triggers a fetch: snapshots and picks do, but before a session is armed
   * neither exists — so an owner opening the room pre-draft, or reloading
   * during a lull, would see "no recommendation yet" while the endpoint was
   * returning a perfectly good board.
   *
   * It also covers the owner's FIRST turn, which by definition has no earlier
   * pick to have pre-warmed it.
   */
  | { kind: "opened" }
  /**
   * Which team is the owner's. Comes from the league connection, NOT from the
   * draft stream — 005's snapshot never carries it.
   *
   * Without this `myTeamId` stays null and three things fail QUIETLY: the
   * owner's column is never highlighted, `rosterView()` filters their picks to
   * nothing, and the bye grid is empty. Nothing errors; the screen just omits
   * the owner from their own draft.
   */
  | { kind: "identity"; myTeamId: number | null }
  | { kind: "frame"; frame: DraftFrame }
  | { kind: "recommendation"; board: RankedBoardLike | null; forRevision: number }
  | { kind: "reachability"; state: Reachability }
  | { kind: "tick" };

export type Effect = { kind: "fetchRecommendation" } | { kind: "fetchSnapshot" };

export function initialState(over: Partial<RoomState> = {}): RoomState {
  return {
    phase: "pre_draft",
    picks: [],
    revision: 0,
    epoch: null,
    cursor: -1,
    onTheClock: null,
    picksUntilMyTurn: null,
    myTeamId: null,
    myTurnState: "idle",
    totalPicks: 0,
    recommendation: null,
    recommendationRevision: null,
    inFlight: false,
    dirty: false,
    reachability: "reconnecting",
    withholding: null,
    completion: null,
    draftAt: null,
    order: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------

interface SnapshotShape {
  revision?: number;
  picks?: Pick[];
  onTheClock?: number | null;
  picksUntilMyTurn?: number | null;
  totalPicks?: number;
  complete?: boolean;
}

/** Apply a snapshot wholesale. It is authoritative — never merged. */
function applySnapshot(state: RoomState, frame: DraftFrame, at: number): RoomState {
  const snap = (frame.state ?? {}) as SnapshotShape;
  const picks = [...(snap.picks ?? [])].sort((a, b) => a.overall - b.overall);
  const next: RoomState = {
    ...state,
    epoch: frame.epoch,
    cursor: frame.seq,
    revision: snap.revision ?? state.revision,
    picks,
    onTheClock: snap.onTheClock ?? null,
    picksUntilMyTurn: snap.picksUntilMyTurn ?? null,
    totalPicks: snap.totalPicks ?? state.totalPicks,
    phase: picks.length > 0 ? "live" : state.phase,
  };
  return concludeCompletion(withTurnState(next), snap.complete === true, at);
}

/** `myTurnState` from the turn distance. Drives the VISUAL state only (FR-004). */
function withTurnState(state: RoomState): RoomState {
  const d = state.picksUntilMyTurn;
  const myTurnState: TurnState = d === 0 ? "on_the_clock" : d !== null && d <= 2 ? "on_deck" : "idle";
  return { ...state, myTurnState };
}

/**
 * Completion, by EITHER route (FR-022).
 *
 * `signalSaysComplete` comes from 005; the pick count is derived locally. When
 * they disagree the state still completes and `divergent` records it — that
 * divergence is the first real evidence anyone will have about which route to
 * trust, and silently resolving it would throw the evidence away (FR-022b).
 */
function concludeCompletion(state: RoomState, signalSaysComplete: boolean, at: number): RoomState {
  const countSaysComplete = state.totalPicks > 0 && state.picks.length >= state.totalPicks;
  if (!signalSaysComplete && !countSaysComplete) return state;
  const by: Completion["by"] =
    signalSaysComplete && countSaysComplete ? "both" : signalSaysComplete ? "signal" : "pick_count";
  return {
    ...state,
    phase: "complete",
    completion: { by, at, divergent: signalSaysComplete !== countSaysComplete },
  };
}

/** Add a pick if its player is not already placed. Additive, never reconciling. */
function placePick(picks: Pick[], pick: Pick): Pick[] {
  if (picks.some((p) => p.playerId === pick.playerId || p.overall === pick.overall)) return picks;
  return [...picks, pick].sort((a, b) => a.overall - b.overall);
}

/**
 * A pick landed: refresh the recommendation (FR-003).
 *
 * ONE REQUEST IN FLIGHT, ONE TRAILING. Measured autodraft produced ~1 pick per
 * second; firing per pick would mean 60 requests a minute at the busiest moment
 * of the draft. This bounds cost by ROUND-TRIP TIME instead, and degrades in the
 * right direction — a slow server produces fewer requests, never a queue.
 */
function requestRefresh(state: RoomState): { state: RoomState; effects: Effect[] } {
  if (state.inFlight) return { state: { ...state, dirty: true }, effects: [] };
  return { state: { ...state, inFlight: true, dirty: false }, effects: [{ kind: "fetchRecommendation" }] };
}

export function reduce(
  state: RoomState,
  input: RoomInput,
  at: number,
): { state: RoomState; effects: Effect[] } {
  switch (input.kind) {
    case "identity":
      return { state: { ...state, myTeamId: input.myTeamId }, effects: [] };

    case "opened":
      return requestRefresh(state);

    case "reachability":
      return { state: { ...state, reachability: input.state }, effects: [] };

    case "tick":
      return { state, effects: [] };

    case "recommendation": {
      const cleared = { ...state, inFlight: false };
      // FR-016: a board computed for a superseded revision is discarded, not
      // rendered. Holding it would show advice for a draft that has moved on.
      const accepted =
        input.board !== null && input.forRevision === state.revision
          ? { ...cleared, recommendation: input.board, recommendationRevision: input.forRevision }
          : cleared;
      // The trailing refresh: exactly one, however many picks landed meanwhile.
      if (state.dirty) {
        return {
          state: { ...accepted, inFlight: true, dirty: false },
          effects: [{ kind: "fetchRecommendation" }],
        };
      }
      return { state: accepted, effects: [] };
    }

    case "frame":
      return reduceFrame(state, input.frame, at);
  }
}

function reduceFrame(state: RoomState, frame: DraftFrame, at: number): { state: RoomState; effects: Effect[] } {
  // An EPOCH CHANGE is a reset, not an error. The epoch regenerates on every
  // rebuild; carrying a stale cursor across one would silently skip a
  // reconstructed draft.
  if (state.epoch !== null && frame.epoch !== state.epoch && frame.type !== "snapshot") {
    return { state: { ...state, epoch: null, cursor: -1 }, effects: [{ kind: "fetchSnapshot" }] };
  }

  if (frame.type === "snapshot") {
    const next = applySnapshot(state, frame, at);
    // A fresh snapshot always invalidates whatever board we held.
    return requestRefresh({ ...next, recommendation: null, recommendationRevision: null });
  }

  // DUPLICATES ARE FREE. 005's stream is explicit that they are expected; a
  // resync on every duplicate would storm at exactly the busiest moment.
  if (frame.seq <= state.cursor) return { state, effects: [] };

  // A true FORWARD GAP means we missed something — only then re-read.
  if (frame.seq > state.cursor + 1) {
    return { state, effects: [{ kind: "fetchSnapshot" }] };
  }

  const advanced = { ...state, cursor: frame.seq };
  // `payload` — the key the server actually sends, and the one the ratified
  // stream contract names (005 contracts/api.md: `{type, epoch, seq, revision,
  // kind, payload}`).
  //
  // This read `frame.event`, which nothing has ever set. So EVERY live event
  // resolved to `{}` and fell through to `default:`: no pick placed, no turn
  // update, no completion, no refresh requested. The cursor still advanced, so
  // there was no gap either — the board simply never moved, and only changed
  // when a reconnect delivered a fresh snapshot. That is the freeze, and it is
  // why a couple of picks appeared and then nothing.
  //
  // `frame.event` is kept as a fallback ONLY so a hand-written fixture from
  // before this was found still parses. Nothing in `src/` emits it.
  const event = ((frame as { payload?: unknown }).payload ?? frame.event ?? {}) as {
    kind?: string;
    revision?: number;
    overall?: number;
    teamId?: number;
    playerId?: number;
    picksUntil?: number;
    totalPicks?: number;
  };

  // A REVISION BUMP is a correction: 005 replays the affected turns, so the
  // local view and the held recommendation are both suspect.
  if (typeof event.revision === "number" && event.revision !== state.revision) {
    return {
      state: { ...advanced, revision: event.revision, recommendation: null, recommendationRevision: null },
      effects: [{ kind: "fetchSnapshot" }],
    };
  }

  switch (event.kind) {
    case "pick_made": {
      if (event.overall === undefined || event.teamId === undefined || event.playerId === undefined) {
        return { state: advanced, effects: [] };
      }
      const picks = placePick(advanced.picks, {
        overall: event.overall,
        teamId: event.teamId,
        playerId: event.playerId,
      });
      const withPick: RoomState = { ...advanced, picks, phase: "live" };
      const completed = concludeCompletion(withPick, false, at);
      if (completed.phase === "complete") return { state: completed, effects: [] };
      return requestRefresh(completed);
    }

    case "on_deck": {
      const next = withTurnState({ ...advanced, picksUntilMyTurn: event.picksUntil ?? null });
      // NOT a fetch trigger (FR-004) — refreshing per pick already keeps the
      // board current, which is what dissolves the snake turnaround.
      return { state: next, effects: [] };
    }

    case "on_the_clock": {
      const next = withTurnState({ ...advanced, picksUntilMyTurn: 0, onTheClock: event.teamId ?? null });
      return { state: next, effects: [] };
    }

    case "draft_complete": {
      const withTotal = { ...advanced, totalPicks: event.totalPicks ?? advanced.totalPicks };
      return { state: concludeCompletion(withTotal, true, at), effects: [] };
    }

    default:
      return { state: advanced, effects: [] };
  }
}
