// 006 T009 — assemble the engine's slow-changing half from D1.
//
// THIS FILE LIVES IN `src/db/`, NOT `src/engine/`, AND THAT IS THE POINT.
//
// It reads five tables. Putting it inside the engine tree would force
// `tests/engine/purity.test.ts` to carry a named exemption — and an exemption
// is exactly how a categorically pure tree stops being one. The rule "nothing
// under src/engine/ touches the platform" has no exceptions to remember, which
// is the only kind of rule that survives a year of edits.
//
// The reads here are the same ones `/board` already performs and serves today,
// so the cost is known rather than estimated. No cache: the bundle changes on
// the projection-refresh cadence, so one could be added in front of it later
// without touching a rule — but nothing measured says it is needed, and
// Constitution VIII says not to build it until something does.

import type { EngineBundle, SignalKind, SignalValue } from "../engine/types";
import { getSnapshot } from "./leagues";
import { listBoardUniverse } from "./players";
import { getServingSet, getSetRows } from "./projections";
import { getSignalMaps } from "./signals";
import { listPreferred } from "./preferred";
import { buildLeagueBoard } from "../projections/scoring";
import { detectAdpFloor } from "../projections/adpFloor";
import { isStale } from "../projections/freshness";
import type { ScoringSnapshot, RosterSnapshot } from "../espn/parsers";

const KINDS: SignalKind[] = ["offense", "sos", "oline"];

export class NoProjectionsError extends Error {
  constructor() {
    super("no serving projection set");
    this.name = "NoProjectionsError";
  }
}

export async function loadEngineBundle(
  db: D1Database,
  accountId: string,
  connectionId: string,
  season: number,
  now: Date,
): Promise<EngineBundle> {
  const serving = await getServingSet(db, season);
  if (!serving) throw new NoProjectionsError();

  const [snapshot, universe, rows, signalMaps, preferredRows] = await Promise.all([
    getSnapshot(db, connectionId),
    listBoardUniverse(db),
    getSetRows(db, serving.id),
    getSignalMaps(db),
    listPreferred(db, accountId, connectionId, season),
  ]);
  if (!snapshot) throw new NoProjectionsError();

  const scoring = JSON.parse(snapshot.scoring_json) as ScoringSnapshot;
  const roster = JSON.parse(snapshot.roster_json) as RosterSnapshot;

  const players = buildLeagueBoard(universe, rows, scoring.items);

  // BoardEntry carries the team ABBREV, not the ESPN pro-team id, and signals
  // are keyed by id. The universe rows have both, so the join happens here
  // rather than making the engine re-derive it.
  const proTeamByPlayer = new Map<number, number>(universe.map((p) => [p.espn_player_id, p.pro_team_id]));

  const signals = new Map<SignalKind, Map<number, SignalValue>>();
  const signalFreshness = new Map<SignalKind, { computedAt: string; provenance: string }>();
  for (const kind of KINDS) {
    const m = signalMaps.get(kind);
    // An absent kind is left ABSENT rather than inserted empty: the engine must
    // be able to tell "no O-line data at all" from "this team has none", and
    // report the right one (FR-013).
    if (!m || m.size === 0) continue;
    signals.set(kind, m);
    const any = m.values().next().value as SignalValue | undefined;
    if (any) signalFreshness.set(kind, { computedAt: any.computed_at, provenance: any.provenance });
  }

  return {
    players,
    signals,
    proTeamByPlayer,
    roster,
    teamCount: snapshot.team_count,
    preferred: new Set(preferredRows.map((r) => r.espn_player_id)),
    // Detected per projection set from the values actually being served, so a
    // season in which ESPN's floor moves is handled without anyone noticing.
    adpFloor: detectAdpFloor(players.map((p) => p.adp)),
    freshness: { fetchedAt: serving.fetched_at, stale: isStale(serving.fetched_at, now) },
    signalFreshness,
  };
}
