// 008 T016/T017/T018/T021 — the shadow replay.
//
// Walk a completed draft forward and, at every one of the owner's turns, ask
// the engine what it would have said. The engine is called EXACTLY as
// `src/api/recommendations.ts` calls it — `deriveState()` then `recommend()` —
// so there is no adapter to drift and no second assembly path to keep in step.
// That is what makes "invoke the engine unmodified" structural rather than a
// promise.
//
// SHADOW means the REAL picks are authoritative. The engine's preference never
// alters the sequence, so every turn is evaluated against the board as it
// actually stood. The moment the engine's own choice is applied instead, every
// subsequent real pick becomes counterfactual and the opponents have to be
// modelled — that is `simulate.ts`, and it is a different thing with different
// evidential weight. `tests/lab/replay.test.ts` asserts the two do not blur.
//
// PURE. No clock, no filesystem, no network — the caller supplies the entry and
// the thawed bundle, and `tests/lab/boundary.test.ts` asserts it structurally.
// A replay that consulted anything ambient could not be re-run in 2028 and get
// the same answer, which is the only property that makes a baseline meaningful.

import { deriveState, type PlayerInfo } from "../engine/state";
import { recommend } from "../engine/recommend";
import { teamAt } from "../draft/snake";
import type { EngineBundle, AdjustmentRule, Recommendation, Warning } from "../engine/types";
import type { CorpusEntry, Fidelity } from "./corpus";

export interface TurnObservation {
  overall: number;
  round: number;
  roundPick: number;
  engineHead: { playerId: number; name: string; rawValue: number; finalValue: number } | null;
  shortlist: Recommendation[];
  /** The player actually taken. Always present — the pick happened. */
  actualPlayerId: number;
  /**
   * Where that player sat in the engine's ordering.
   *
   * NULL means the drafted player was not on the ranked board at all — obscure,
   * released, or outside the serving projection set. Normal, not an error: it
   * is STATED (FR-005) and the turn still resolves.
   */
  actual: { name: string; rank: number; finalValue: number } | null;
  /** How far the owner's pick trailed the engine's, in the league's currency. */
  gapToHead: number | null;
  /** The same gap in ROUNDS — the only unit comparable across leagues. */
  gapInRounds: number | null;
  roundValue: number;
  forced: boolean;
  warnings: Warning[];
  /**
   * Which rule changed the outcome, if any.
   *
   * Derived from the engine's own output — the head under `finalValue` versus
   * the head under `rawValue` — and never from a second ranking implementation.
   * Null when the rules moved nobody past anybody.
   */
  decisiveRule: AdjustmentRule | null;
}

export interface ReplayResult {
  entryId: string;
  turns: TurnObservation[];
  /** Picks the replay actually applied, for the shadow-property assertion. */
  appliedPicks: number[];
}

export class NotReplayableError extends Error {
  constructor(entryId: string, reason: string) {
    super(`${entryId} is not replayable: ${reason}`);
    this.name = "NotReplayableError";
  }
}

/**
 * The withholding value a replay always uses, at ONE named place.
 *
 * 005's `withholding` is a verdict about whether the tap is still delivering
 * picks. In a replay there is no tap and no liveness, so the condition cannot
 * arise — and saying that here, once, with a name, is the difference between a
 * documented divergence from production and a default that happens to fall
 * through. The same shape as 006's `totalPicks = 0`, where a value meaning
 * "unknown" was read as a claim.
 */
const REPLAY_HAS_NO_TAP = null;

export function replayEntry(entry: CorpusEntry, bundle: EngineBundle): ReplayResult {
  if (entry.useClass !== "replayable") {
    // Structural refusal, not a convention. A `pick_sequence_only` entry has no
    // contemporaneous board — running the engine against today's board over a
    // 2024 pick sequence produces numbers that look like evidence and are not.
    throw new NotReplayableError(entry.id, entry.unreplayableReason ?? "use class is pick_sequence_only");
  }
  if (entry.myTeamId === null) throw new NotReplayableError(entry.id, "no owner team");
  if (entry.order.length === 0) throw new NotReplayableError(entry.id, "pick order unknown");

  const myTeamId = entry.myTeamId;

  const playerInfo = new Map<number, PlayerInfo>(
    bundle.players.map((p) => [p.espn_player_id, { position: p.position, byeWeek: p.bye_week }]),
  );
  const byId = new Map(bundle.players.map((p) => [p.espn_player_id, p]));
  const keepers = new Map<number, number>(entry.keepers.map((k) => [k.playerId, k.teamId]));

  const ordered = [...entry.picks].sort((a, b) => a.overall - b.overall);
  const observed = new Map<number, number>(ordered.map((p) => [p.overall, p.teamId]));

  const turns: TurnObservation[] = [];
  for (const current of ordered) {
    // Whose turn it is comes from the ROUND and the order — never from a field
    // on the pick. 010's oracle disproved the field-3-is-the-round reading at 5
    // of 70, and `teamAt` prefers what was observed over what was projected.
    const holder = teamAt({ order: entry.order, overall: current.overall, observed });
    if (holder !== myTeamId) continue;

    // Everything before this pick, and nothing else. `deriveState` computes
    // `frontier = picks.length + 1`, so this puts the engine exactly on the
    // clock for `current.overall`.
    const before = ordered.filter((p) => p.overall < current.overall);

    const state = deriveState({
      revision: current.overall,
      picks: before.map((p) => ({ overall: p.overall, teamId: p.teamId, playerId: p.playerId })),
      order: entry.order,
      myTeamId,
      totalPicks: entry.totalPicks,
      keepers,
      playerInfo,
      withholding: REPLAY_HAS_NO_TAP,
    });

    const board = recommend(bundle, state);
    const head = board.entries[0] ?? null;
    const actualEntry = board.entries.find((e) => e.playerId === current.playerId) ?? null;
    const actualName = byId.get(current.playerId)?.name;

    const gapToHead =
      head && actualEntry ? round4(head.finalValue - actualEntry.finalValue) : null;

    turns.push({
      overall: current.overall,
      round: current.round,
      roundPick: current.roundPick,
      engineHead: head
        ? { playerId: head.playerId, name: head.name, rawValue: head.rawValue, finalValue: head.finalValue }
        : null,
      shortlist: board.shortlist,
      actualPlayerId: current.playerId,
      // A drafted player absent from the ranked board is NORMAL: obscure,
      // released, or outside the serving projection set. The turn still
      // resolves and the absence is stated rather than thrown.
      actual: actualEntry
        ? {
            name: actualEntry.name ?? actualName ?? `Player ${current.playerId}`,
            rank: actualEntry.rank,
            finalValue: actualEntry.finalValue,
          }
        : null,
      gapToHead,
      gapInRounds:
        gapToHead !== null && board.roundValue > 0 ? round4(gapToHead / board.roundValue) : null,
      roundValue: board.roundValue,
      forced: board.forced,
      warnings: board.warnings,
      decisiveRule: decisiveRule(board.entries, board.shortlist),
    });
  }

  return { entryId: entry.id, turns, appliedPicks: ordered.map((p) => p.overall) };
}

/**
 * Which rule, if any, changed who came first.
 *
 * Two steps, and both read out of `recommend()`'s own output — re-ranking here
 * would be a second implementation of the thing under test:
 *
 *   1. Did the rules change the head? Compare the engine's ordering (by
 *      `finalValue`) against the leader by `rawValue`. Same player ⇒ the rules
 *      broke no tie that mattered, and the answer is null.
 *   2. If they did, name the cause: the largest-magnitude adjustment on the
 *      player who won. That needs an explanation, and only the shortlist
 *      carries those — which is why both arguments are required.
 *
 * Null is also the honest answer when the new head is not in the shortlist,
 * which cannot happen today (the head is always first) but would silently
 * mis-attribute if `SHORTLIST_SIZE` ever became 0.
 */
export function decisiveRule(
  entries: readonly { playerId: number; rawValue: number; finalValue: number }[],
  shortlist: readonly Recommendation[],
): AdjustmentRule | null {
  const head = entries[0];
  if (!head) return null;

  let rawLeader = head;
  for (const e of entries) if (e.rawValue > rawLeader.rawValue) rawLeader = e;
  if (rawLeader.playerId === head.playerId) return null;

  const explained = shortlist.find((s) => s.playerId === head.playerId);
  if (!explained) return null;

  let best: { rule: AdjustmentRule; magnitude: number } | null = null;
  for (const a of explained.explanation.adjustments) {
    if (best === null || Math.abs(a.magnitude) > Math.abs(best.magnitude)) {
      best = { rule: a.rule, magnitude: a.magnitude };
    }
  }
  return best?.rule ?? null;
}

/** The fidelity a replay inherits from its entry's snapshot. */
export function fidelityFor(entry: CorpusEntry, snapshotTakenDuringDraft: boolean): Fidelity {
  const notes: string[] = [];
  if (!snapshotTakenDuringDraft) {
    notes.push(
      "signals were recomputed after this draft — signal_entries is overwritten in place and has no history",
    );
  }
  if (entry.provenanceClass === "test") {
    notes.push("test run: replays correctly, inadmissible as evidence for a rule change");
  }
  return {
    board: "as_of",
    signals: snapshotTakenDuringDraft ? "as_of" : "present_day",
    preferred: snapshotTakenDuringDraft ? "as_of" : "present_day",
    scoring: "present_day",
    notes,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
