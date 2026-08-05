// 005 T048/T049 — reconciling the tap-built draft against ESPN's own record.
//
// PURE. The fetch and the archive write live at the call site.
//
// WHY THIS EXISTS: the one thing Gate 0 proved ESPN writes reliably is the
// COMPLETED draft. That makes it useless as a live source and valuable as an
// INDEPENDENT ORACLE — it is derived without the tap, so it can catch a
// systematic error that self-consistency never could.
//
// It has already earned its keep twice, in 010: it disproved the reading of
// `SELECTED`'s third field as the round (agreeing on 5 of 70 picks) and
// confirmed the ledger offsets (31/31). Promoting it to production costs one
// request per draft and makes every archived draft verified against a source
// that did not produce it.
//
// DIVERGENCE IS RECORDED, NOT SILENTLY RESOLVED. Preferring one side without
// saying so would hide exactly the class of error this check exists to find.

import type { Pick } from "./reconcile";
import type { CompletedPick } from "../espn/parsers";

export interface Divergence {
  /** In ESPN's record, absent from ours — the serious direction. */
  missing: { overall: number; teamId: number; playerId: number }[];
  /** In ours, absent from ESPN's. */
  extra: { overall: number; teamId: number; playerId: number }[];
  /** Same player, different position or team. */
  mismatched: { playerId: number; ours: { overall: number; teamId: number }; espn: { overall: number; teamId: number } }[];
  ourCount: number;
  espnCount: number;
}

export function isClean(d: Divergence): boolean {
  return d.missing.length === 0 && d.extra.length === 0 && d.mismatched.length === 0;
}

/**
 * Compare on PLAYER IDENTITY, not on position.
 *
 * Comparing by `overall` would report every pick after a single off-by-one as
 * wrong, burying the actual defect in noise. Identity localises it: one moved
 * player reads as one mismatch.
 */
export function compareToOracle(ours: readonly Pick[], espn: readonly CompletedPick[]): Divergence {
  const ourByPlayer = new Map(ours.map((p) => [p.playerId, p]));
  const espnByPlayer = new Map(espn.map((p) => [p.playerId, p]));

  const missing: Divergence["missing"] = [];
  const mismatched: Divergence["mismatched"] = [];
  for (const e of espn) {
    const o = ourByPlayer.get(e.playerId);
    if (!o) {
      missing.push({ overall: e.overall, teamId: e.teamId, playerId: e.playerId });
      continue;
    }
    if (o.overall !== e.overall || o.teamId !== e.teamId) {
      mismatched.push({
        playerId: e.playerId,
        ours: { overall: o.overall, teamId: o.teamId },
        espn: { overall: e.overall, teamId: e.teamId },
      });
    }
  }

  const extra = ours
    .filter((o) => !espnByPlayer.has(o.playerId))
    .map((o) => ({ overall: o.overall, teamId: o.teamId, playerId: o.playerId }));

  return { missing, extra, mismatched, ourCount: ours.length, espnCount: espn.length };
}

/**
 * Adopt ESPN's record where the two disagree.
 *
 * ESPN's post-completion flush is the league's own book of record: at this
 * point the draft is over and its version is the one the owner will see in
 * ESPN forever. Ours is a reconstruction from a live stream. Where they differ,
 * ESPN wins — but the difference is recorded alongside, so a systematic tap
 * problem shows up rather than being quietly papered over.
 *
 * Returns null when there is nothing to correct, so the caller can skip the
 * revision bump entirely.
 */
export function reconciledPicks(ours: readonly Pick[], espn: readonly CompletedPick[]): Pick[] | null {
  const d = compareToOracle(ours, espn);
  if (isClean(d)) return null;
  if (espn.length === 0) return null; // nothing to reconcile against

  const ourByPlayer = new Map(ours.map((p) => [p.playerId, p]));
  return espn
    .map((e) => {
      const o = ourByPlayer.get(e.playerId);
      return {
        overall: e.overall,
        teamId: e.teamId,
        playerId: e.playerId,
        // Carried opaquely; ESPN's record does not restate it.
        slot3: o?.slot3 ?? 0,
        // FIRST-SEEN-WINS: our observation time is when the pick actually
        // happened. ESPN's flush timestamp is when the draft ENDED, and
        // adopting it would flatten every pick onto one instant, destroying
        // the per-pick timing 008's replay lab depends on.
        observedAt: o?.observedAt ?? "",
        epoch: o?.epoch ?? 0,
      };
    })
    .sort((a, b) => a.overall - b.overall);
}
