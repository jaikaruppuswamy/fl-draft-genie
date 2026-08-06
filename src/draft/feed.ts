// 005 T009 — the feed cursor (FR-007h).
//
// PURE. No platform imports; `src/db/tap.ts` owns the actual query.
//
// The session is fed by PULLING from the durable log the ingest already wrote,
// not by having frames pushed into it. That shape is forced by one constraint:
// the tap discards its local buffer only when the server returns
// `accepted_through`, which makes the acknowledgement a durability boundary.
// Acking before a durable write loses picks the tap has already forgotten;
// acking after a Durable Object round-trip lets a restarting or migrating
// object stall the tap's buffer. Writing the log, acking, and then nudging
// satisfies both — and a dropped nudge then costs latency, never data.
//
// WHY A KEYSET, NOT AN OFFSET: a batch inserted while a read is in flight
// shifts an offset window and silently skips a row. `(received_at, id)` is
// stable under concurrent inserts.
//
// WHY NOT "RE-READ AND DEDUPE": the reducer IS idempotent (FR-010), but that
// should be a safety net, not the mechanism. A design whose correctness depends
// on its own error-tolerance has no margin left when something else goes wrong.

/** Where the session has read up to. `null` means "from the beginning". */
export interface FeedCursor {
  receivedAt: string;
  id: string;
}

/**
 * One row of `tap_batches`, as the session sees it.
 *
 * Carries NO relayer identity — no account, no install id, no tap session id.
 * Under 011's fan-out these frames cross from the relaying manager's tap into
 * every other manager's session, and FR-003/SC-003 require that a delivered view
 * never names who relayed it. The fields were here and unused; leaving them
 * would have made that guarantee a matter of nobody having reached for them.
 */
export interface FeedBatch {
  id: string;
  receivedAt: string;
  firstSeq: number;
  lastSeq: number;
  messages: RelayMessage[];
}

/** A message as 010 relays it. Shape owned by 010's contracts/ingest.md. */
export interface RelayMessage {
  v: number;
  seq: number;
  epoch: number;
  observedAt: string;
  transport: "ws" | "sse";
  kind: "pick" | "ledger" | "status";
  payload: unknown;
}

export interface PickObservation {
  teamId: number;
  playerId: number;
  /** Unresolved protocol field, carried opaque. NEVER interpreted (see below). */
  slot3: number;
  overallPickNumber?: number;
  observedAt: string;
  /** Stamps are comparable only WITHIN one epoch — the tap re-anchors on wake. */
  epoch: number;
}

export interface Observation {
  /** Incremental picks, in arrival order. */
  picks: PickObservation[];
  /** A complete ledger snapshot, when one arrived. Authoritative baseline. */
  ledger: PickObservation[] | null;
  /** Tap status frames, which drive FR-007f withholding. */
  statuses: { state: string; observedAt: string }[];
  /** The cursor to persist AFTER this observation is committed. */
  cursor: FeedCursor;
}

/**
 * ESPN's empty-slot sentinel.
 *
 * **Never filter on sign.** D/ST player ids are legitimately negative, around
 * −16000. `playerId > 0` is what made 010's capture script report 66 of 72
 * picks for a complete draft, and an earlier revision of this feature's own
 * data model carried the same rule. Compare against the sentinel.
 */
export const EMPTY_PLAYER_ID = -1;

/** Is this a real pick rather than an unfilled slot? */
export function isFilled(playerId: number): boolean {
  return playerId !== EMPTY_PLAYER_ID;
}

/** Strictly after `cursor` in (receivedAt, id) order. */
export function isAfter(cursor: FeedCursor | null, b: { receivedAt: string; id: string }): boolean {
  if (cursor === null) return true;
  if (b.receivedAt !== cursor.receivedAt) return b.receivedAt > cursor.receivedAt;
  return b.id > cursor.id;
}

/** Total order over the keyset, so ties on `received_at` resolve by id. */
export function compareBatches(
  a: { receivedAt: string; id: string },
  b: { receivedAt: string; id: string },
): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The cursor to persist after committing `batches`.
 *
 * Returns the PREVIOUS cursor for an empty read, never a fabricated one — the
 * caller must not advance past nothing.
 */
export function advanceCursor(previous: FeedCursor | null, batches: readonly FeedBatch[]): FeedCursor | null {
  if (batches.length === 0) return previous;
  const last = [...batches].sort(compareBatches).at(-1)!;
  return { receivedAt: last.receivedAt, id: last.id };
}

interface PickPayload {
  teamId?: unknown;
  playerId?: unknown;
  slot3?: unknown;
  overallPickNumber?: unknown;
}

function toPick(p: PickPayload, m: RelayMessage): PickObservation | null {
  const teamId = Number(p.teamId);
  const playerId = Number(p.playerId);
  const slot3 = Number(p.slot3);
  if (!Number.isInteger(teamId) || !Number.isInteger(playerId) || !Number.isInteger(slot3)) return null;
  if (!isFilled(playerId)) return null;
  const overall = Number(p.overallPickNumber);
  return {
    teamId,
    playerId,
    slot3,
    overallPickNumber: Number.isInteger(overall) ? overall : undefined,
    observedAt: m.observedAt,
    epoch: m.epoch,
  };
}

/**
 * Fold a batch read into one observation for the reducer.
 *
 * The LEDGER wins as the baseline where present: 010 established it arrives
 * first in any session and is what recovers picks the incremental stream
 * dropped — in the observed draft, 3 of 72 picks existed ONLY in a ledger.
 * Both sources are kept; the reducer unions them on pick identity.
 */
/** How much of the draft a ledger snapshot accounts for. */
function coverage(rows: PickObservation[]): number {
  let max = 0;
  for (const r of rows) max = Math.max(max, r.overallPickNumber ?? 0);
  // Ordinal-less rows cannot be measured by position, so fall back to volume.
  return Math.max(max, rows.length);
}

export function foldBatches(previous: FeedCursor | null, batches: readonly FeedBatch[]): Observation {
  const ordered = [...batches].sort(compareBatches);
  const picks: PickObservation[] = [];
  const statuses: { state: string; observedAt: string }[] = [];
  let ledger: PickObservation[] | null = null;

  for (const b of ordered) {
    for (const m of [...b.messages].sort((x, y) => x.seq - y.seq)) {
      if (m.kind === "pick") {
        const p = toPick((m.payload ?? {}) as PickPayload, m);
        if (p) picks.push(p);
      } else if (m.kind === "ledger") {
        const rows = Array.isArray(m.payload) ? (m.payload as PickPayload[]) : [];
        const decoded = rows.map((r) => toPick(r, m)).filter((p): p is PickObservation => p !== null);
        // Keep the ledger with the greatest COVERAGE, not the latest arrival.
        //
        // Arrival order is not recency here: a tap that buffered through an
        // outage (FR-008) flushes an OLD snapshot with a NEW `received_at`.
        // Ordering by arrival then threw away a 40-row ledger in favour of a
        // stale 5-row one from a reconnecting second tab — discarding exactly
        // the recovery data the ledger exists to provide.
        if (ledger === null || coverage(decoded) > coverage(ledger)) ledger = decoded;
      } else if (m.kind === "status") {
        const s = (m.payload ?? {}) as { state?: unknown };
        if (typeof s.state === "string") statuses.push({ state: s.state, observedAt: m.observedAt });
      }
    }
  }

  return { picks, ledger, statuses, cursor: advanceCursor(previous, ordered) ?? { receivedAt: "", id: "" } };
}
