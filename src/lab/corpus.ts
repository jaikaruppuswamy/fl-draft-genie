// 008 T005/T007 — the corpus entry, and the invariants that decide whether one
// may be replayed at all.
//
// PURE. No filesystem, no clock, no network — `tests/lab/boundary.test.ts`
// asserts that structurally, the same way 006 asserts the engine's purity.
// That is not decoration: a corpus entry must produce the same replay in 2028
// as it does today, and anything ambient makes that untrue by definition.
//
// TWO CLASSIFICATIONS, AND THEY ARE ORTHOGONAL. Conflating them is the mistake
// this file exists to prevent:
//
//   useClass         can the engine run on this at all?
//                    `replayable` needs a board, and a board only exists for a
//                    season the projections pipeline covered. A 2024 draft can
//                    never become replayable — ESPN will not serve a past
//                    season's preseason projections at any price.
//
//   provenanceClass  is this evidence?
//                    A mock draft replays PERFECTLY and is still inadmissible.
//                    The room did not behave the way a real room behaves, so
//                    tuning against it fits noise from a non-representative
//                    draft — and nothing downstream can detect the difference.
//
// An entry can be replayable and inadmissible at the same time. Every draft
// captured before this feature existed is exactly that.

/** Bumped when a field is removed or re-meant. Adding an optional field is not. */
export const CORPUS_FORMAT_VERSION = 1;

export type Provenance = "live_frames" | "espn_import" | "archive";
export type ProvenanceClass = "real" | "test";
export type UseClass = "replayable" | "pick_sequence_only";

export interface CorpusPick {
  overall: number;
  round: number;
  roundPick: number;
  teamId: number;
  /**
   * SIGNED, always. `-1` is ESPN's empty-slot sentinel and D/ST ids sit near
   * −16000. `playerId > 0` is what made 010's capture script report 66 of 72
   * picks for a complete draft; nothing in this feature filters on sign.
   */
  playerId: number;
  keeper: boolean;
  autodrafted: boolean;
  /** Present only for `live_frames`. The one thing an import cannot supply. */
  observedAt: string | null;
  /** Stamps compare only WITHIN an epoch — the tap re-anchors across sleep. */
  observedEpoch: number | null;
}

export interface OracleCheck {
  checkedAt: string;
  agreed: number;
  total: number;
  /** RECORDED, never resolved in favour of either side. */
  divergences: { overall: number; ours: number; theirs: number }[];
}

export interface CorpusEntry {
  formatVersion: number;
  id: string;
  season: number;
  espnLeagueId: string;
  provenance: Provenance;
  provenanceClass: ProvenanceClass;
  useClass: UseClass;
  /** Required non-null when `useClass` is `pick_sequence_only`. */
  unreplayableReason: string | null;
  teamCount: number;
  roundCount: number;
  /**
   * Teams × rounds, OR the reconciled count where keepers make those differ.
   * Never assumed — 005 has the keeper reconciliation open, and an entry whose
   * totals do not add up is flagged rather than replayed against a wrong number
   * of remaining picks.
   */
  totalPicks: number;
  myTeamId: number | null;
  /** Round-1 pick order. Empty means unknown, never guessed. */
  order: number[];
  picks: CorpusPick[];
  /** EVERY team's keepers, not only the owner's. */
  keepers: { teamId: number; playerId: number }[];
  startedAt: string | null;
  completedAt: string;
  oracle: OracleCheck | null;
  /** Overall numbers known to be missing. Non-empty ⇒ unreplayable. */
  gaps: number[];
}

/**
 * Which engine inputs were reconstructed, and which were borrowed from today.
 *
 * FR-015. Attached to every run, and there is deliberately no code path that
 * produces a run without one — a replay that quietly mixes an August board with
 * November's signals produces numbers that look authoritative and are not.
 */
export interface Fidelity {
  board: "as_of" | "present_day" | "unavailable";
  signals: "as_of" | "present_day" | "unavailable";
  preferred: "as_of" | "present_day";
  scoring: "as_of" | "present_day";
  notes: string[];
}

/** A validation failure, naming the entry and the invariant it broke. */
export interface CorpusViolation {
  entryId: string;
  invariant: string;
  detail: string;
}

/**
 * Check every invariant from contracts/corpus.md.
 *
 * Returns violations rather than throwing on the first: a corpus of ten drafts
 * with three bad entries should report three problems, not one. A caller that
 * finds any violation must REFUSE the entry — never skip it silently, which
 * would shrink a corpus without anyone noticing.
 */
export function validateEntry(entry: CorpusEntry, hasSnapshot: boolean): CorpusViolation[] {
  const out: CorpusViolation[] = [];
  const fail = (invariant: string, detail: string): void => {
    out.push({ entryId: entry.id, invariant, detail });
  };

  // Version first: every check below reads fields whose meaning the version
  // governs, so validating an unknown version would be interpreting bytes we
  // do not understand.
  if (entry.formatVersion !== CORPUS_FORMAT_VERSION) {
    fail(
      "formatVersion",
      `unknown format version ${entry.formatVersion} (this build reads ${CORPUS_FORMAT_VERSION})`,
    );
    return out;
  }

  const overalls = entry.picks.map((p) => p.overall);
  for (let i = 1; i < overalls.length; i++) {
    if (overalls[i]! <= overalls[i - 1]!) {
      fail("picks.sorted", `pick ${overalls[i]} does not follow ${overalls[i - 1]}`);
      break;
    }
  }
  if (new Set(overalls).size !== overalls.length) {
    fail("picks.unique", "two picks share an overall number");
  }

  // Contiguity, allowing exactly the holes `gaps` declares. A draft missing
  // picks it does not admit to is the failure mode: replayed as-is it looks
  // like a shorter draft, and every turn after the hole is against a board that
  // still contains a player who is actually gone.
  const gapSet = new Set(entry.gaps);
  const seen = new Set(overalls);
  const expected = entry.totalPicks;
  if (expected > 0) {
    const undeclared: number[] = [];
    for (let n = 1; n <= expected; n++) {
      if (!seen.has(n) && !gapSet.has(n)) undeclared.push(n);
    }
    if (undeclared.length > 0) {
      fail(
        "picks.contiguous",
        `${undeclared.length} pick(s) missing and not declared in gaps: ${undeclared.slice(0, 5).join(", ")}${undeclared.length > 5 ? "…" : ""}`,
      );
    }
    if (seen.size + entry.gaps.length !== expected) {
      // Keeper leagues legitimately differ from teams × rounds, which is why
      // this is a check and not an assumption.
      fail(
        "totalPicks.reconciles",
        `totalPicks ${expected} ≠ picks ${seen.size} + gaps ${entry.gaps.length}`,
      );
    }
  }

  if (entry.useClass === "replayable") {
    if (entry.myTeamId === null) fail("replayable.myTeamId", "no owner team, so there are no owner turns");
    if (entry.order.length === 0) fail("replayable.order", "pick order unknown; it is never guessed");
    if (entry.gaps.length > 0) {
      fail("replayable.gaps", `${entry.gaps.length} pick(s) missing; a partial draft is not replayed`);
    }
    if (!hasSnapshot) fail("replayable.snapshot", "no input snapshot, so no board to rank against");
    if (entry.unreplayableReason !== null) {
      fail("replayable.reason", "a replayable entry must not carry an unreplayable reason");
    }
  } else {
    if (!entry.unreplayableReason) {
      fail("pick_sequence_only.reason", "must say why it cannot be replayed");
    }
  }

  return out;
}

/**
 * True when an entry may contribute to a rule-set comparison.
 *
 * BOTH conditions, and the second is the one that is easy to forget: a test
 * draft is perfectly replayable and still not evidence.
 */
export function isAdmissible(entry: CorpusEntry): boolean {
  return entry.useClass === "replayable" && entry.provenanceClass === "real";
}

/** Why an entry was left out, for the scorecard's `excluded[]`. Never silent. */
export function exclusionReason(entry: CorpusEntry): string | null {
  if (entry.useClass !== "replayable") {
    return `not replayable: ${entry.unreplayableReason ?? "no reason recorded"}`;
  }
  if (entry.provenanceClass === "test") {
    return "test run — a mock room does not draft the way a real one does";
  }
  return null;
}
