// 007 — shared builders for the room tests.
//
// Everything here constructs the reducer's arguments directly. That is the
// whole claim of the design: the room's logic is a function of its inputs, so
// its tests state those inputs and need no browser to do it.

import type { DraftFrame } from "../../web/src/lib/draftSocket";
import type { Pick, RoomState } from "../../web/src/lib/draftRoom";
import { initialState } from "../../web/src/lib/draftRoom";
import type { PlayerLookup } from "../../web/src/lib/draftRoomSelectors";

export const EPOCH = "epoch-1";

export function snapshotFrame(over: Partial<DraftFrame> & { state?: unknown } = {}): DraftFrame {
  return { type: "snapshot", epoch: EPOCH, seq: 0, state: { picks: [], revision: 0 }, ...over } as DraftFrame;
}

export function eventFrame(seq: number, event: Record<string, unknown>, epoch = EPOCH): DraftFrame {
  return { type: "event", epoch, seq, event } as unknown as DraftFrame;
}

export function pickFrame(seq: number, overall: number, teamId: number, playerId: number): DraftFrame {
  return eventFrame(seq, { kind: "pick_made", overall, teamId, playerId });
}

export function armed(over: Partial<RoomState> = {}): RoomState {
  return initialState({ epoch: EPOCH, cursor: 0, myTeamId: 1, totalPicks: 72, ...over });
}

export function board(revision: number, over: Record<string, unknown> = {}) {
  return {
    revision,
    withheld: null,
    forced: false,
    needs: [],
    round_value: 10,
    warnings: [],
    shortlist: [],
    entries: [],
    ...over,
  } as never;
}

export function picks(...triples: [number, number, number][]): Pick[] {
  return triples.map(([overall, teamId, playerId]) => ({ overall, teamId, playerId }));
}

export function lookup(entries: [number, PlayerLookup][]): Map<number, PlayerLookup> {
  return new Map(entries);
}
