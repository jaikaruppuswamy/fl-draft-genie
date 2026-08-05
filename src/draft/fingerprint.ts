// 005 — `stateFingerprint`: what FR-014's "identical rebuilt state" means.
//
// PURE. No platform imports.
//
// THE DELIBERATE NARROWING (research §7, documented rather than left implicit):
// a rebuild CANNOT reproduce the original event stream, and pretending
// otherwise would make FR-014 unsatisfiable. Replaying the log collapses N
// separate observations into however many reads the rebuild happens to take,
// so the events differ in number and grouping even though the DRAFT is
// identical.
//
// So the fingerprint covers what a rebuild must reproduce exactly — the picks,
// the order, the revision, completion — and excludes what it provably cannot:
// the delivery cursor, the event window, the epoch and the delivery seq. Those
// are transport bookkeeping, not draft facts.

import type { DraftState } from "./reconcile";

/**
 * A stable, order-independent digest of the DRAFT, not of how it was delivered.
 *
 * Deliberately a plain string rather than a hash: it is compared, never
 * transmitted, and being able to read the difference in a failing test is worth
 * more than the bytes.
 */
export function stateFingerprint(s: DraftState): string {
  const picks = [...s.picks]
    .sort((a, b) => a.overall - b.overall)
    .map((p) => `${p.overall}:${p.teamId}:${p.playerId}`)
    .join(",");
  return [
    `order=${s.order.join("-")}`,
    `my=${s.myTeamId ?? "?"}`,
    `total=${s.totalPicks}`,
    `rev=${s.revision}`,
    `complete=${s.complete ? 1 : 0}`,
    `picks=${picks}`,
  ].join("|");
}
