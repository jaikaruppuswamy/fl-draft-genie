// 008 T055/T057/T058 — the counterfactual draft.
//
// The engine makes the owner's picks; modelled opponents make everyone else's.
// This is the only way to see a ROSTER-level consequence rather than a per-turn
// one, and roster quality is ultimately what the engine is for.
//
// IT IS ALSO THE WEAKEST EVIDENCE IN THIS FEATURE, and the output says so in a
// field rather than in a comment. The moment the engine takes a different
// player from the one the owner actually took, every subsequent real pick
// becomes counterfactual — the opponents would have faced a different board —
// so the rest of the draft is a model's opinion, not a record. A shadow replay
// reports what would have been said against the board as it truly stood; this
// reports what might have happened. Merging the two would let a modelled
// finding acquire a measured finding's standing, which `modelDependent` exists
// to prevent.

import { deriveState, type PlayerInfo } from "../engine/state";
import { recommend } from "../engine/recommend";
import { teamAt } from "../draft/snake";
import { gaussian, mulberry32 } from "./rng";
import type { EngineBundle } from "../engine/types";
import type { CorpusEntry } from "./corpus";

export interface OpponentModel {
  kind: "adp_noise";
  /**
   * Spread of the noise applied to ADP, in ADP positions.
   *
   * Set from `observeAdpBehaviour()` over real drafts (FR-020c) — NOT chosen.
   * When no measurement exists the caller must say so, and `grounded` below
   * carries that admission into every result.
   */
  noiseSd: number;
  grounded: boolean;
  seed: number;
}

export interface SimulatedPick {
  overall: number;
  teamId: number;
  playerId: number;
  by: "engine" | "opponent";
}

export interface SimulationResult {
  entryId: string;
  model: OpponentModel;
  picks: SimulatedPick[];
  /** What the engine built for the owner. */
  engineRoster: { playerId: number; name: string; position: string }[];
  /** What the owner actually built, from the same entry. */
  ownerRoster: { playerId: number; name: string; position: string }[];
  /**
   * ALWAYS true. A literal rather than a computed value, so that removing the
   * label requires deleting this line and explaining why in a diff.
   */
  modelDependent: true;
}

export function simulateDraft(
  entry: CorpusEntry,
  bundle: EngineBundle,
  model: OpponentModel,
): SimulationResult {
  if (entry.myTeamId === null) throw new Error(`${entry.id}: no owner team to simulate for`);
  if (entry.order.length === 0) throw new Error(`${entry.id}: no pick order to simulate against`);

  const myTeamId = entry.myTeamId;
  const rand = mulberry32(model.seed);
  const byId = new Map(bundle.players.map((p) => [p.espn_player_id, p]));
  const playerInfo = new Map<number, PlayerInfo>(
    bundle.players.map((p) => [p.espn_player_id, { position: p.position, byeWeek: p.bye_week }]),
  );
  const keepers = new Map<number, number>(entry.keepers.map((k) => [k.playerId, k.teamId]));

  const taken = new Set<number>(keepers.keys());
  const picks: SimulatedPick[] = [];
  const observed = new Map<number, number>();

  for (let overall = 1; overall <= entry.totalPicks; overall++) {
    const teamId = teamAt({ order: entry.order, overall, observed });
    if (teamId === null) break;

    const playerId =
      teamId === myTeamId
        ? enginePick(overall, teamId)
        : opponentPick();

    if (playerId === null) break;
    taken.add(playerId);
    observed.set(overall, teamId);
    picks.push({ overall, teamId, playerId, by: teamId === myTeamId ? "engine" : "opponent" });
  }

  const roster = (ids: readonly number[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .map((p) => ({ playerId: p.espn_player_id, name: p.name, position: p.position }));

  return {
    entryId: entry.id,
    model,
    picks,
    engineRoster: roster(picks.filter((p) => p.teamId === myTeamId).map((p) => p.playerId)),
    // The SAME measure for both sides (FR-030) — the owner's real picks read
    // through the same board, so the two rosters are directly comparable.
    ownerRoster: roster(entry.picks.filter((p) => p.teamId === myTeamId).map((p) => p.playerId)),
    modelDependent: true,
  };

  function enginePick(overall: number, teamId: number): number | null {
    const state = deriveState({
      revision: overall,
      picks: picks.map((p) => ({ overall: p.overall, teamId: p.teamId, playerId: p.playerId })),
      order: entry.order,
      myTeamId: teamId,
      totalPicks: entry.totalPicks,
      keepers,
      playerInfo,
      // Same reason as the shadow replay: there is no tap in a simulation, so
      // the withholding condition cannot arise.
      withholding: null,
    });
    const board = recommend(bundle, state);
    return board.entries[0]?.playerId ?? null;
  }

  /**
   * The opponent model: best available by NOISY ADP.
   *
   * One sentence, reproducible from a seed, and honest about being a model.
   * Anything richer would have error nobody could characterise — and the
   * temptation to tune the opponents until the engine looks good is exactly
   * what makes richer models dangerous here.
   */
  function opponentPick(): number | null {
    let best: { id: number; key: number } | null = null;
    for (const p of bundle.players) {
      if (taken.has(p.espn_player_id)) continue;
      // No usable ADP ⇒ sort to the back rather than to the front. A missing
      // value must never look like "the most desirable player available".
      const adp = p.adp ?? Number.MAX_SAFE_INTEGER / 2;
      const key = adp + gaussian(rand) * model.noiseSd;
      if (best === null || key < best.key) best = { id: p.espn_player_id, key };
    }
    return best?.id ?? null;
  }
}
