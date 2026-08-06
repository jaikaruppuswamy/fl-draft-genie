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
import { latestBatchCursor, readBatchesAfter, type FeedCursorRow } from "../db/tap";
import { markSessionStatus } from "../db/draft";
import { foldBatches, type FeedBatch, type RelayMessage } from "./feed";
import { initialState, reconcile, trust, frontier, type DraftEvent, type DraftState } from "./reconcile";
import { picksUntilTurn, teamAt } from "./snake";
import { stateFingerprint } from "./fingerprint";

/** Bounds SC-001's "100% within 10 s" when a nudge is lost. */
export const SAFETY_ALARM_MS = 5_000;

/** One read cannot pull an unbounded draft into memory. */
export const READ_LIMIT = 200;

/**
 * 011 T004 — the two halves of a session's scope, named apart.
 *
 * One shape used to carry both, and that conflation is the root of every defect
 * 011 fixes. The fields are unchanged; what changes is that the compiler now
 * knows which half each belongs to, so a value taken from the wrong manager is a
 * type error rather than a silent perspective bleed.
 *
 * THE RULE, in one line:
 *
 *   Frames are LEAGUE-SHARED. Perspective is PER-ACCOUNT.
 *
 * `DraftFacts` describes the draft itself — the same for every manager watching
 * it, because they are all watching the same ESPN room.
 */
export interface DraftFacts {
  espnLeagueId: string;
  season: number;
  /** Round-1 pick order. Derived from the picks; see 008's finding on this. */
  order: number[];
}

/**
 * `ManagerView` is one manager's own context. **Never taken from a relayer.**
 *
 * `totalPicks` sits here rather than in `DraftFacts` deliberately, and it is the
 * field most likely to be moved by someone tidying up. Two managers in one
 * league recorded 11 and 12 rounds for the SAME draft on 2026-08-06 — one
 * snapshot was stale. Each session must use its own, and the disagreement is
 * surfaced (FR-005) rather than one manager's stale sync silently reshaping
 * another's board.
 */
export interface ManagerView {
  accountId: string;
  connectionId: string;
  myTeamId: number | null;
  totalPicks: number;
}

/**
 * What a session is armed with: the shared draft, plus exactly one manager's
 * view of it.
 *
 * Kept as a flat intersection so every existing call site and stored record
 * still reads `scope.myTeamId` — this is a naming change, not a migration. The
 * Durable Object keeps its address (`connectionId:season`); delivery becomes
 * league-wide by FANNING OUT to each manager's session, never by re-keying.
 */
export type SessionScope = DraftFacts & ManagerView;

/** Last 500 events, backing `?since=` resume (contracts/api.md rule 2). */
export const EVENT_WINDOW = 500;

interface Delivered {
  seq: number;
  event: DraftEvent;
}

interface Stored {
  scope: SessionScope | null;
  state: DraftState;
  cursor: FeedCursorRow | null;
  /**
   * Regenerated on every REBUILD, which is what stops a stale client cursor
   * from silently skipping a reconstructed draft (contracts/api.md rule 3).
   */
  epoch: string;
  /** Monotonic WITHIN an epoch. Delivery bookkeeping, not a draft fact — which
   *  is why it lives here and not in `DraftState`: `stateFingerprint` must not
   *  see it, or FR-014 becomes unsatisfiable (research §7). */
  deliverySeq: number;
  eventWindow: Delivered[];
  /**
   * TERMINAL and intentional: set only by `shutdown()`, when the league is
   * disconnected. Deliberately NOT set on completion.
   *
   * It used to latch on `state.complete` too, with no clearing path anywhere —
   * so a single premature completion (a wrong `totalPicks` from pre-draft data,
   * for instance) silenced the session for the rest of a live draft, and
   * `arm()`, whose whole job is to correct late-arriving pre-draft data, could
   * not undo it. Completion is a BELIEF derived from data and must stay
   * revisable; a disconnect is a decision and does not.
   */
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
    if (s.closed) return; // disconnected: an explicit decision, not a belief
    // An abort is about a draft that never started. If it is being armed
    // again, the draft is back on and the abort no longer applies.
    await this.ctx.storage.delete("aborted");
    await this.ctx.storage.put("scope", scope);
    if (!s.scope) {
      await this.ctx.storage.put("epoch", crypto.randomUUID());
      await this.ctx.storage.put(
        "state",
        initialState({ order: scope.order, myTeamId: scope.myTeamId, totalPicks: scope.totalPicks }),
      );
    } else {
      // Refresh the parts the draft's structure depends on; keep the picks.
      const totalPicks = scope.totalPicks || s.state.totalPicks;
      await this.ctx.storage.put("state", {
        ...s.state,
        order: scope.order.length ? scope.order : s.state.order,
        myTeamId: scope.myTeamId ?? s.state.myTeamId,
        totalPicks,
        // RE-EVALUATE completion against the corrected total. Pre-draft data
        // arrives late and can be wrong; if it said 24 picks and the truth is
        // 72, the session must come back to life rather than stay silent for
        // the rest of the draft.
        complete: totalPicks > 0 && s.state.picks.length >= totalPicks,
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

  /**
   * Rebuild the draft from the durable log (FR-014, T032).
   *
   * Deliberately NOT a separate restore routine. It resets the cursor and then
   * runs the SAME `pumpOnce` the live path runs — so the recovery code is
   * exercised on every pick of every draft, not only in the emergency it was
   * written for. A restore path that runs once a season is a restore path that
   * has rotted by the time it is needed; 010's draft-end detection shipped
   * broken for precisely that reason.
   *
   * The epoch is regenerated, which invalidates every client cursor: rule 3 of
   * the stream contract, and what stops a stale cursor from silently skipping
   * a reconstructed draft.
   */
  async rebuild(): Promise<number> {
    const s = await this.load();
    if (!s.scope || s.closed) return 0;
    await this.ctx.storage.put({
      state: initialState({
        order: s.scope.order.length ? s.scope.order : s.state.order,
        myTeamId: s.scope.myTeamId ?? s.state.myTeamId,
        totalPicks: s.scope.totalPicks || s.state.totalPicks,
      }),
      epoch: crypto.randomUUID(),
      deliverySeq: 0,
      eventWindow: [],
    });
    // Rewind to the START OF THIS DRAFT, not the start of the log. After a
    // reset the log still holds the previous draft (FR-029), and a rebuild that
    // rewound past the floor would restore exactly what the reset discarded.
    const floor = await this.ctx.storage.get<FeedCursorRow>("logFloor");
    if (floor) await this.ctx.storage.put("cursor", floor);
    else await this.ctx.storage.delete("cursor");

    // Drain the whole log, not just the first page: a full draft is more than
    // one READ_LIMIT window, and stopping early would rebuild a partial draft
    // that looks complete.
    let total = 0;
    for (;;) {
      const n = await this.pumpOnce();
      total += n;
      const after = await this.load();
      const more = await readBatchesAfter(
        this.env.DB,
        { readerConnectionId: after.scope!.connectionId, espnLeagueId: after.scope!.espnLeagueId, season: after.scope!.season },
        after.cursor,
        1,
      );
      if (more.length === 0) break;
    }
    return total;
  }

  /** The digest FR-014 compares a rebuilt draft against. */
  async fingerprint(): Promise<string> {
    return stateFingerprint((await this.load()).state);
  }

  /**
   * Give up on a draft that never started (FR-002, postponed drafts).
   *
   * Distinct from `shutdown()`: the session row survives so the owner can see
   * WHY it stopped, and a re-published draft time re-arms it through the
   * ordinary sync with no manual step. What stops is the billing — an armed
   * session holds its alarm open indefinitely otherwise.
   */
  async abort(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    const s = await this.load();
    await this.ctx.storage.put("state", { ...s.state, complete: false });
    await this.ctx.storage.put("aborted", true);
  }

  /**
   * 011 T042 — clear the draft, keep the session (FR-027).
   *
   * The distinction from `shutdown()` is the entire point, and it is one flag:
   * shutdown sets `closed`, and `arm()` returns early on `closed`. That makes
   * shutdown PERMANENT — which is why, before this existed, the only way to run
   * a second mock draft was to disconnect the league and reconnect it. That
   * mints a new connection id and took a preferred player with it on
   * 2026-08-06.
   *
   * So this deletes the draft's own keys by name rather than calling
   * `deleteAll()`. Naming them is deliberate: a future key that ought to
   * survive a reset (an enablement, a retained frame index) would be destroyed
   * silently by a blanket wipe, and nothing here would fail.
   *
   * THE CURSOR IS MOVED FORWARD, NOT CLEARED, and that is the subtle half.
   * Clearing it rewinds the session to the start of a log that deliberately
   * OUTLIVES the reset (FR-029) — so the very next pump would faithfully
   * re-import the draft just discarded. The floor is recorded so `rebuild()`,
   * which legitimately rewinds to recover from storage loss, rewinds only to
   * the start of THIS draft rather than into the previous one.
   */
  async reset(): Promise<void> {
    const s = await this.load();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete([
      "state",
      "cursor",
      "epoch",
      "deliverySeq",
      "eventWindow",
      "aborted",
    ]);

    const floor = s.scope
      ? await latestBatchCursor(this.env.DB, {
          readerConnectionId: s.scope.connectionId,
          espnLeagueId: s.scope.espnLeagueId,
          season: s.scope.season,
        })
      : null;
    if (floor) await this.ctx.storage.put({ cursor: floor, logFloor: floor });
    else await this.ctx.storage.delete("logFloor");

    // `scope` stays: it is the league, the season and this manager's team, none
    // of which the reset is about. `closed` is never set — that is the flag
    // that would make this permanent.
  }

  /** Stop everything and forget. Called when a league is disconnected. */
  async shutdown(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("closed", true);
  }

  // --- internals -----------------------------------------------------------

  private async load(): Promise<Stored> {
    const [scope, state, cursor, closed, epoch, deliverySeq, eventWindow] = await Promise.all([
      this.ctx.storage.get<SessionScope>("scope"),
      this.ctx.storage.get<DraftState>("state"),
      this.ctx.storage.get<FeedCursorRow>("cursor"),
      this.ctx.storage.get<boolean>("closed"),
      this.ctx.storage.get<string>("epoch"),
      this.ctx.storage.get<number>("deliverySeq"),
      this.ctx.storage.get<Delivered[]>("eventWindow"),
    ]);
    return {
      scope: scope ?? null,
      state: state ?? initialState(),
      cursor: cursor ?? null,
      closed: closed ?? false,
      epoch: epoch ?? "",
      deliverySeq: deliverySeq ?? 0,
      eventWindow: eventWindow ?? [],
    };
  }

  /**
   * Read → reduce → commit → broadcast.
   *
   * Returns the number of events produced, so tests and the alarm can tell a
   * productive sweep from an idle one.
   */
  private async pump(): Promise<number> {
    // SERIALISED. `pump` is a read-modify-write whose middle is a D1 query —
    // a NON-storage await, which does not close the Durable Object input gate.
    // Two nudges (or a nudge racing the alarm) would otherwise both reduce from
    // the same base state: the loser's commit rolls the winner's picks and
    // cursor backwards, and both emit the same turn events, breaking
    // "exactly once per revision".
    //
    // `blockConcurrencyWhile` is the documented way to hold the gate across an
    // arbitrary await. The work is a single D1 read plus one storage put, so
    // the serialisation costs nothing a draft can notice.
    return this.ctx.blockConcurrencyWhile(() => this.pumpOnce());
  }

  private async pumpOnce(): Promise<number> {
    const s = await this.load();
    // Note this does NOT stop on `state.complete`. A completed session still
    // accepts frames, because a later ledger can prove the completion wrong —
    // and a session that refuses to look is one that cannot self-heal. What
    // completion stops is the ALARM, in `ensureAlarm`.
    if (!s.scope || s.closed) return 0;

    const rows = await readBatchesAfter(
      this.env.DB,
      { readerConnectionId: s.scope.connectionId, espnLeagueId: s.scope.espnLeagueId, season: s.scope.season },
      s.cursor,
      READ_LIMIT,
    );
    if (rows.length === 0) return 0;

    const batches: FeedBatch[] = rows.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt,
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
    // Delivery seqs are assigned HERE, not in the reducer: they are transport
    // bookkeeping, and keeping them out of DraftState is what lets
    // `stateFingerprint` compare a rebuilt draft to an incrementally-built one.
    const delivered: Delivered[] = events.map((event, i) => ({ seq: s.deliverySeq + i + 1, event }));
    const eventWindow = [...s.eventWindow, ...delivered].slice(-EVENT_WINDOW);

    await this.ctx.storage.put({
      state,
      ...(cursorMoved ? { cursor: observation.cursor } : {}),
      ...(delivered.length ? { deliverySeq: s.deliverySeq + delivered.length, eventWindow } : {}),
    });

    if (delivered.length) this.broadcast(s.epoch, delivered);

    // T058: mirror the status to D1, AFTER the commit. D1 is what the cron
    // sweep and the diagnostic surface read; the object's own storage is
    // invisible to both. This writes no credential — the session holds none
    // (FR-024a) — only a status and a timestamp.
    //
    // Failure here must not roll back a committed draft: the state is already
    // durable, and the next pump or the sweep will write it again.
    try {
      if (state.complete) {
        await markSessionStatus(this.env.DB, s.scope.connectionId, "complete", new Date());
      } else if (state.picks.length > 0) {
        await markSessionStatus(this.env.DB, s.scope.connectionId, "live", new Date());
      }
    } catch {
      /* the sweep will reconcile it */
    }

    await this.ensureAlarm();
    return events.length;
  }

  /**
   * Fan out to every attached socket, AFTER the commit.
   *
   * `ctx.getWebSockets()` is why the Hibernation API is mandatory rather than
   * preferred: sockets accepted with `server.accept()` are invisible to it, so
   * after an eviction the session could not enumerate — or reach — its own
   * clients. Every socket gets identical frames with identical `seq`, so tabs
   * converge with no coordination.
   */
  private broadcast(epoch: string, delivered: Delivered[]): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    for (const d of delivered) {
      const frame = JSON.stringify({
        type: "event",
        epoch,
        seq: d.seq,
        revision: d.event.revision,
        kind: d.event.kind,
        payload: d.event,
      });
      for (const ws of sockets) {
        // One dead socket must never stop the others from being told.
        try {
          ws.send(frame);
        } catch {
          /* the close handler will clean it up */
        }
      }
    }
  }

  /**
   * WebSocket upgrade. Strictly server → client: client frames are ignored, and
   * the protocol has no client commands at all (Constitution VI keeps this
   * one-way by design).
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const s = await this.load();
    if (!s.scope) return new Response("not armed", { status: 409 });

    const since = Number(new URL(request.url).searchParams.get("since") ?? NaN);
    const clientEpoch = new URL(request.url).searchParams.get("epoch");

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    // Rule 1: the opening frame is ALWAYS a snapshot, sent before the 101.
    server.send(
      JSON.stringify({ type: "snapshot", epoch: s.epoch, seq: s.deliverySeq, state: this.toSnapshot(s) }),
    );

    // Rule 2/3: replay only for a client whose cursor is same-epoch AND still
    // inside the retained window. Anything else already has its full snapshot
    // and simply resets — an out-of-range cursor is not an error.
    const sameEpoch = clientEpoch === null || clientEpoch === s.epoch;
    const oldest = s.eventWindow[0]?.seq ?? Infinity;
    if (sameEpoch && Number.isFinite(since) && since >= oldest - 1) {
      for (const d of s.eventWindow.filter((e) => e.seq > since)) {
        server.send(
          JSON.stringify({
            type: "event",
            epoch: s.epoch,
            seq: d.seq,
            revision: d.event.revision,
            kind: d.event.kind,
            payload: d.event,
          }),
        );
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** One-way protocol: there are no client commands to handle. */
  webSocketMessage(): void {}

  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code, "closing");
    } catch {
      /* already gone */
    }
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
    const aborted = (await this.ctx.storage.get<boolean>("aborted")) === true;
    if (!s.scope || s.closed || aborted || s.state.complete) {
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
