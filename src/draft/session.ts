// 005 T021-T024 — the DraftSession Durable Object.
//
// The sole authority for one league's live draft state. It is FED BY PULLING
// from the durable log the ingest already wrote (`tap_batches`), never by
// having frames pushed into it.
//
// WHY PULL (FR-007h). The tap discards its local buffer only when the server
// returns `accepted_through`, which makes that acknowledgement a durability
// boundary rather than a courtesy:
//
//   * ack BEFORE the durable write → we lose picks the tap has already
//     forgotten;
//   * ack AFTER a round-trip to this object → a restarting or migrating session
//     stalls the tap's buffer, which is the outcome FR-008's buffering
//     guarantees exist to prevent.
//
// Writing the log, acking, and only then nudging satisfies both. The nudge
// carries NO frame data — only "there is new work" — so a dropped nudge costs
// latency, never a pick. The 5 s alarm is what turns that into a bound.
//
// It also collapses two code paths into one: rebuilding a dead session replays
// the same log through the same cursor read, so the recovery path is exercised
// on every pick rather than only after a crash. The restore routine that runs
// only in emergencies is the one that rots — 010's draft-end detection shipped
// broken for exactly that reason.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { readBatchesAfter, type FeedCursorRow } from "../db/tap";
import { foldBatches, type FeedBatch, type RelayMessage } from "./feed";
import { initialState, reconcile, trust, frontier, type DraftEvent, type DraftState } from "./reconcile";
import { picksUntilTurn, teamAt } from "./snake";

/** Bounds SC-001's "100% within 10 s" when a nudge is lost. */
export const SAFETY_ALARM_MS = 5_000;

/** One read cannot pull an unbounded draft into memory. */
const READ_LIMIT = 200;

export interface SessionScope {
  accountId: string;
  connectionId: string;
  espnLeagueId: string;
  season: number;
  myTeamId: number | null;
  order: number[];
  totalPicks: number;
}

interface Stored {
  scope: SessionScope | null;
  state: DraftState;
  cursor: FeedCursorRow | null;
  /** Terminal once the draft completes; stops the alarm rescheduling. */
  closed: boolean;
}

export interface SessionSnapshot {
  status: "idle" | "live" | "complete";
  revision: number;
  seq: number;
  picks: DraftState["picks"];
  onTheClock: number | null;
  picksUntilMyTurn: number | null;
  orderTrust: ReturnType<typeof trust>;
  totalPicks: number;
  complete: boolean;
}

export class DraftSession extends DurableObject<Env> {
  /**
   * Arm the session (FR-007g).
   *
   * Idempotent: a heartbeat arriving every 15 s must not reset anything. The
   * scope is refreshed because pre-draft data (order, team count) can arrive
   * after the first frame.
   */
  async arm(scope: SessionScope): Promise<void> {
    const s = await this.load();
    await this.ctx.storage.put("scope", scope);
    if (!s.scope) {
      await this.ctx.storage.put(
        "state",
        initialState({ order: scope.order, myTeamId: scope.myTeamId, totalPicks: scope.totalPicks }),
      );
    } else {
      // Refresh the parts the draft's structure depends on; keep the picks.
      await this.ctx.storage.put("state", {
        ...s.state,
        order: scope.order.length ? scope.order : s.state.order,
        myTeamId: scope.myTeamId ?? s.state.myTeamId,
        totalPicks: scope.totalPicks || s.state.totalPicks,
      });
    }
    await this.ensureAlarm();
  }

  /**
   * "There is new work." Carries no data by design — see the header.
   *
   * Never throws to the caller: it runs inside `ctx.waitUntil` on the ingest
   * path, and a failure here must not surface as a failed relay when the frames
   * are already durably stored.
   */
  async nudge(): Promise<void> {
    try {
      await this.pump();
    } catch {
      // The log still holds everything; the alarm will retry.
      await this.ensureAlarm();
    }
  }

  /** The safety sweep. This is what makes the 10 s ceiling a guarantee. */
  async alarm(): Promise<void> {
    try {
      await this.pump();
    } finally {
      await this.ensureAlarm();
    }
  }

  async snapshot(): Promise<SessionSnapshot | null> {
    const s = await this.load();
    if (!s.scope) return null;
    return this.toSnapshot(s);
  }

  /** Stop everything and forget. Called when a league is disconnected. */
  async shutdown(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("closed", true);
  }

  // --- internals -----------------------------------------------------------

  private async load(): Promise<Stored> {
    const [scope, state, cursor, closed] = await Promise.all([
      this.ctx.storage.get<SessionScope>("scope"),
      this.ctx.storage.get<DraftState>("state"),
      this.ctx.storage.get<FeedCursorRow>("cursor"),
      this.ctx.storage.get<boolean>("closed"),
    ]);
    return {
      scope: scope ?? null,
      state: state ?? initialState(),
      cursor: cursor ?? null,
      closed: closed ?? false,
    };
  }

  /**
   * Read → reduce → commit → broadcast.
   *
   * Returns the number of events produced, so tests and the alarm can tell a
   * productive sweep from an idle one.
   */
  private async pump(): Promise<number> {
    const s = await this.load();
    if (!s.scope || s.closed) return 0;

    const rows = await readBatchesAfter(
      this.env.DB,
      { accountId: s.scope.accountId, espnLeagueId: s.scope.espnLeagueId, season: s.scope.season },
      s.cursor,
      READ_LIMIT,
    );
    if (rows.length === 0) return 0;

    const batches: FeedBatch[] = rows.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt,
      installId: r.installId,
      sessionId: r.sessionId,
      firstSeq: r.firstSeq,
      lastSeq: r.lastSeq,
      messages: r.messages as RelayMessage[],
    }));

    const observation = foldBatches(s.cursor, batches);
    const { state, events } = reconcile(s.state, observation);

    // T024: do not persist on a no-op. A safety sweep that finds only
    // duplicates produces zero events — but the CURSOR still moved, and not
    // persisting that would re-read the same rows forever. So the gate is
    // "events OR cursor advanced", not "events" alone.
    const cursorMoved =
      observation.cursor.id !== "" &&
      (s.cursor === null ||
        observation.cursor.receivedAt !== s.cursor.receivedAt ||
        observation.cursor.id !== s.cursor.id);
    if (events.length === 0 && !cursorMoved) return 0;

    // COMMIT FIRST, then broadcast. A crash between the two loses a push but
    // not state, and the client's cursor hand-off recovers it. The reverse
    // order can announce a pick that was never durably recorded.
    //
    // The cursor is written in the SAME put as the state: advancing it first
    // would skip rows on a crash, and writing it later could re-apply them.
    await this.ctx.storage.put({
      state,
      ...(cursorMoved ? { cursor: observation.cursor } : {}),
      ...(state.complete ? { closed: true } : {}),
    });

    if (events.length) this.broadcast(events, state);
    await this.ensureAlarm();
    return events.length;
  }

  /**
   * Phase 4 (T029-T031) replaces this with hibernatable WebSocket fan-out.
   * The ordering it must preserve — commit, then broadcast — is established
   * here so the later change is a substitution rather than a restructure.
   */
  private broadcast(_events: DraftEvent[], _state: DraftState): void {
    // no sockets yet
  }

  /**
   * Keep the safety alarm armed while there is a draft to watch.
   *
   * Scheduled ONLY while the session is armed and unfinished: a completed or
   * un-armed session schedules nothing, which is what keeps a postponed draft
   * from billing indefinitely.
   */
  private async ensureAlarm(): Promise<void> {
    const s = await this.load();
    if (!s.scope || s.closed || s.state.complete) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SAFETY_ALARM_MS);
    }
  }

  private toSnapshot(s: Stored): SessionSnapshot {
    const observed = new Map(s.state.picks.map((p) => [p.overall, p.teamId]));
    const f = frontier(s.state);
    return {
      status: s.state.complete ? "complete" : s.state.picks.length > 0 ? "live" : "idle",
      revision: s.state.revision,
      seq: s.state.seq,
      picks: s.state.picks,
      onTheClock: s.state.complete ? null : teamAt({ order: s.state.order, overall: f, observed }),
      picksUntilMyTurn:
        s.state.myTeamId === null
          ? null
          : picksUntilTurn({
              order: s.state.order,
              frontier: f,
              myTeamId: s.state.myTeamId,
              observed,
              totalPicks: s.state.totalPicks || undefined,
            }),
      orderTrust: trust(s.state),
      totalPicks: s.state.totalPicks,
      complete: s.state.complete,
    };
  }
}

/** One session per league connection per season. */
export function sessionIdFor(env: Env, connectionId: string, season: number): DurableObjectId {
  return env.DRAFT_SESSION.idFromName(`${connectionId}:${season}`);
}

export function sessionStub(env: Env, connectionId: string, season: number): DurableObjectStub<DraftSession> {
  return env.DRAFT_SESSION.get(sessionIdFor(env, connectionId, season)) as DurableObjectStub<DraftSession>;
}
