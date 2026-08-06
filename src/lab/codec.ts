// 008 T009 — the input snapshot codec, and canonical serialization.
//
// THE SNAPSHOT IS THE ENGINE'S INPUT, NEVER ITS OUTPUT. That distinction is the
// whole feature. `EngineBundle` is the slow half — board, signals, roster shape,
// preferred list — and freezing it lets a draft be re-ranked under NEW rules
// years later. Freezing the ranked board instead would make every replay return
// August's answer forever, no matter what the rules say, which inverts the
// point of a replay lab entirely.
//
// WHY A CODEC AT ALL: `EngineBundle` carries `Map` and `Set`, and neither
// survives `JSON.stringify`. The conversion is explicit in both directions and
// SORTS on the way out, because FR-009/FR-013 and SC-002 all reduce to "the
// same input produces the same bytes" — and a bundle assembled from two
// different query orderings is the same input.
//
// PURE. No filesystem, no clock, no crypto import: the hash below is written
// out longhand because `src/lab/**` is typechecked without node types, and
// because a corpus written today must hash the same way in 2028 regardless of
// what a platform library does in between.

import type { EngineBundle, SignalKind, SignalValue } from "../engine/types";
import type { BoardEntry } from "../projections/scoring";
import type { RosterSnapshot } from "../espn/parsers";

export const SNAPSHOT_FORMAT_VERSION = 1;

const KINDS: SignalKind[] = ["offense", "sos", "oline"];

export interface InputSnapshot {
  formatVersion: number;
  entryId: string;
  players: BoardEntry[];
  signals: { kind: SignalKind; proTeamId: number; value: SignalValue }[];
  proTeamByPlayer: [number, number][];
  roster: RosterSnapshot;
  teamCount: number;
  preferred: number[];
  adpFloor: number | null;
  freshness: { fetchedAt: string; stale: boolean };
  signalFreshness: { kind: SignalKind; computedAt: string; provenance: string }[];
  sourceSetId: string;
  sourceSetFetchedAt: string;
}

export interface SnapshotSource {
  entryId: string;
  sourceSetId: string;
  sourceSetFetchedAt: string;
}

/**
 * Freeze a bundle.
 *
 * `proTeamByPlayer` is trimmed to players on the board. A drafted player
 * missing from the board is already tolerated by `deriveState()` — it
 * contributes nothing to needs or bye arithmetic — so carrying the whole player
 * universe would inflate every fixture for no behavioural difference.
 */
export function bundleToSnapshot(bundle: EngineBundle, source: SnapshotSource): InputSnapshot {
  const onBoard = new Set(bundle.players.map((p) => p.espn_player_id));

  const signals: InputSnapshot["signals"] = [];
  for (const kind of KINDS) {
    const byTeam = bundle.signals.get(kind);
    if (!byTeam) continue;
    for (const [proTeamId, value] of byTeam) signals.push({ kind, proTeamId, value });
  }

  const signalFreshness: InputSnapshot["signalFreshness"] = [];
  for (const kind of KINDS) {
    const f = bundle.signalFreshness.get(kind);
    if (f) signalFreshness.push({ kind, computedAt: f.computedAt, provenance: f.provenance });
  }

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    entryId: source.entryId,
    // Every array is sorted by its natural key so two assemblies of the same
    // data serialize identically.
    players: [...bundle.players].sort((a, b) => a.espn_player_id - b.espn_player_id),
    signals: signals.sort((a, b) => a.kind.localeCompare(b.kind) || a.proTeamId - b.proTeamId),
    proTeamByPlayer: [...bundle.proTeamByPlayer]
      .filter(([playerId]) => onBoard.has(playerId))
      .sort((a, b) => a[0] - b[0]),
    roster: bundle.roster,
    teamCount: bundle.teamCount,
    preferred: [...bundle.preferred].sort((a, b) => a - b),
    adpFloor: bundle.adpFloor,
    freshness: bundle.freshness,
    signalFreshness: signalFreshness.sort((a, b) => a.kind.localeCompare(b.kind)),
    sourceSetId: source.sourceSetId,
    sourceSetFetchedAt: source.sourceSetFetchedAt,
  };
}

/** Thaw a snapshot back into exactly what the engine expects. */
export function snapshotToBundle(snapshot: InputSnapshot): EngineBundle {
  if (snapshot.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    // Loudly, never a coerce or a fallback. An old snapshot read under new
    // assumptions produces plausible numbers from misinterpreted data, and
    // nothing downstream could tell.
    throw new Error(
      `unknown snapshot format version ${snapshot.formatVersion} (this build reads ${SNAPSHOT_FORMAT_VERSION})`,
    );
  }

  const signals = new Map<SignalKind, Map<number, SignalValue>>();
  for (const s of snapshot.signals) {
    // An ABSENT kind stays absent rather than being inserted empty: the engine
    // distinguishes "no signal" from "a signal of zero", and says so in its
    // explanation.
    let byTeam = signals.get(s.kind);
    if (!byTeam) {
      byTeam = new Map<number, SignalValue>();
      signals.set(s.kind, byTeam);
    }
    byTeam.set(s.proTeamId, s.value);
  }

  const signalFreshness = new Map<SignalKind, { computedAt: string; provenance: string }>();
  for (const f of snapshot.signalFreshness) {
    signalFreshness.set(f.kind, { computedAt: f.computedAt, provenance: f.provenance });
  }

  return {
    players: snapshot.players,
    signals,
    proTeamByPlayer: new Map(snapshot.proTeamByPlayer),
    roster: snapshot.roster,
    teamCount: snapshot.teamCount,
    preferred: new Set(snapshot.preferred),
    adpFloor: snapshot.adpFloor,
    freshness: snapshot.freshness,
    signalFreshness,
  };
}

/**
 * Deterministic serialization: sorted keys, optional fixed rounding, two-space
 * indent, trailing newline.
 *
 * `round` is applied to scorecards and comparisons, where a float's full
 * decimal expansion is noise that hides the one line that mattered. It is NOT
 * applied to snapshots: board values carry the engine's own rounding already,
 * and re-rounding them would change the input a replay is run against.
 */
export function canonicalJson(value: unknown, opts: { round?: number } = {}): string {
  return JSON.stringify(sortDeep(value, opts.round), null, 2) + "\n";
}

function sortDeep(value: unknown, round?: number): unknown {
  if (Array.isArray(value)) return value.map((v) => sortDeep(v, round));
  if (typeof value === "number") {
    if (round === undefined || !Number.isFinite(value)) return value;
    const f = 10 ** round;
    // `+ 0` collapses -0 to 0: they stringify differently and mean the same
    // thing, which is exactly the kind of difference that reads as a rule
    // effect in a diff.
    return Math.round(value * f) / f + 0;
  }
  if (value === null || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k], round);
  return out;
}

/**
 * FNV-1a, 64-bit, over the canonical form.
 *
 * Written longhand rather than imported: `src/lab/**` has no node types, and a
 * hash that a corpus depends on should not be able to change underneath it.
 * Collisions are irrelevant here — this compares a run to itself, so the only
 * property needed is that different bytes reliably give different digests.
 */
export function canonicalHash(value: unknown, opts: { round?: number } = {}): string {
  const text = canonicalJson(value, opts);
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    // charCodeAt, not codePointAt: surrogate halves hash independently and
    // consistently, which is all this needs.
    hash = (hash ^ BigInt(text.charCodeAt(i))) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
