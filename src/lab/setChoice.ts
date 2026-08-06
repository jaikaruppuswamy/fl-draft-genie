// 008 T011 — which projection set was serving when a draft ran.
//
// `getServingSet()` answers "which set is serving NOW", which is right for
// production and wrong for a replay: a draft that ran three weeks ago was
// ranked against the set serving THEN, and the pipeline publishes a new one
// daily through August and September plus a top-up on draft morning.
//
// The decision lives here, in the tested pure core; fetching the candidate rows
// is I/O and lives in the admitting script. Adding a query to
// `src/db/projections.ts` for a lab-only need would put lab concerns into
// worker code for no benefit.
//
// THE ONE THING NOT TO DO is fall back to the nearest set when none predates
// the draft. A board published after a draft already reflects what happened in
// it — players who were taken, injuries that landed — so ranking that draft
// against it is not an approximation of the truth, it is a different question
// with a confident-looking answer. FR-019d: no set, no snapshot, entry marked
// unreplayable.

/** The subset of `projection_sets` this decision needs. */
export interface CandidateSet {
  id: string;
  status: string;
  fetched_at: string;
  season: number;
}

/**
 * The newest COMPLETE set fetched at or before `at`, or null.
 *
 * `at` is the draft's start time. Null is a real answer — the caller marks the
 * entry unreplayable and says so — never a signal to look harder.
 */
export function chooseSetAt(rows: readonly CandidateSet[], at: string | null): CandidateSet | null {
  if (!at) return null;
  let best: CandidateSet | null = null;
  for (const row of rows) {
    // `building` sets are partial by definition — 002 publishes atomically, and
    // a half-ingested board would rank against a board that never served
    // anyone.
    if (row.status !== "complete") continue;
    // ISO-8601 UTC strings compare correctly as strings, which is why 002
    // stores them that way. No Date construction here: `src/lab/**` has no
    // clock, and parsing would introduce one.
    if (row.fetched_at > at) continue;
    if (best === null || row.fetched_at > best.fetched_at) best = row;
  }
  return best;
}
