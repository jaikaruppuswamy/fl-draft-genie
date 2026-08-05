// 005 T034/T036 — rebuild and reconnect (US2, FR-014, SC-005).
//
// Constitution V: a live draft cannot be paused or replayed. A monitor that is
// correct only while nothing goes wrong is not a draft-day monitor — so the
// interesting cases here are all failures: the session is destroyed mid-draft,
// a client reconnects with a stale cursor, the event window overflows.
//
// FR-014 is asserted on `stateFingerprint`, which deliberately EXCLUDES the
// delivery cursor, epoch and event window. A rebuild collapses N observations
// into however many reads it takes, so it provably cannot reproduce the
// original event stream; requiring that would make the criterion unsatisfiable
// (research §7). What it must reproduce exactly is the DRAFT.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftSession, READ_LIMIT, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-rebuild";
const CONNECTION = "conn-rebuild";
const LEAGUE = "7777777777";
const SEASON = 2026;
const ORDER = [5, 2, 1, 3, 6, 4];

const testEnv = env as unknown as Env;

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: 1,
  order: ORDER,
  totalPicks: 72,
};

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

function pickMessage(seq: number, teamId: number, playerId: number) {
  return {
    v: 1,
    seq,
    epoch: 0,
    observedAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    transport: "ws" as const,
    kind: "pick" as const,
    payload: { teamId, playerId, slot3: 0 },
  };
}

async function writeBatch(id: string, receivedAt: string, messages: unknown[]): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO tap_batches
       (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
        received_at, first_seq, last_seq, message_count, kinds, messages_json)
     VALUES (?, ?, ?, ?, ?, 'install-1', 'session-1', ?, 0, 0, ?, 'pick', ?)`,
  )
    .bind(id, ACCOUNT, CONNECTION, LEAGUE, SEASON, receivedAt, messages.length, JSON.stringify(messages))
    .run();
}

/** Relay `n` picks one batch at a time, nudging after each — as production does. */
async function relay(n: number, from = 1): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await writeBatch(`rb-${String(i).padStart(4, "0")}`, new Date(1_800_000_000_000 + i * 1000).toISOString(), [
      pickMessage(i, ORDER[(i - 1) % ORDER.length]!, 5000 + i),
    ]);
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
  }
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "rebuild@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("rebuild from the durable log (FR-014)", () => {
  it("reproduces the incrementally-built draft EXACTLY", async () => {
    await relay(20);
    const before = await runInDurableObject(stub(), (s: DraftSession) => s.fingerprint());

    await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());
    const after = await runInDurableObject(stub(), (s: DraftSession) => s.fingerprint());

    expect(after).toBe(before);
  });

  it("survives total storage loss, not just a reset", async () => {
    // The real failure: the object is evicted or the Worker redeployed, and
    // everything the session held is gone. The log is what brings it back.
    await relay(20);
    const before = await runInDurableObject(stub(), (s: DraftSession) => s.fingerprint());

    await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
    });
    await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
    await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());

    expect(await runInDurableObject(stub(), (s: DraftSession) => s.fingerprint())).toBe(before);
  });

  it("drains the WHOLE log, not just the first page", async () => {
    // Stopping after one page would rebuild a partial draft that LOOKS
    // complete — the worst possible shape, because nothing downstream can tell.
    //
    // This must exceed READ_LIMIT to mean anything. An earlier version relayed
    // 72 picks against a 200-row page and passed even with the loop cut to a
    // single iteration: a test that could not fail.
    const n = READ_LIMIT + 40;
    for (let i = 1; i <= n; i++) {
      await writeBatch(`rp-${String(i).padStart(4, "0")}`, new Date(1_800_000_000_000 + i * 1000).toISOString(), [
        pickMessage(i, ORDER[(i - 1) % ORDER.length]!, 6000 + i),
      ]);
    }
    await runInDurableObject(stub(), (s: DraftSession) => s.arm({ ...scope, totalPicks: n }));
    await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());

    const snap = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    expect(snap!.picks).toHaveLength(n);
    expect(snap!.complete).toBe(true);
  });

  it("REGENERATES the epoch, so a stale client cursor cannot skip the rebuild", async () => {
    await relay(5);
    const epochBefore = await snapshotEpoch(await open());

    await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());
    const epochAfter = await snapshotEpoch(await open());

    expect(epochAfter).not.toBe(epochBefore);
  });

  it("preserves PER-PICK observation times through a rebuild (T035)", async () => {
    // The failure this guards: a cold rebuild that stamps every pick with one
    // observation time. The draft would look right and 008's replay lab would
    // be worthless, because per-pick timing is the whole point of that corpus.
    // The log carries each frame's original `observedAt`, so replaying it must
    // reproduce distinct times rather than collapsing them.
    await relay(10);
    const before = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    const timesBefore = before!.picks.map((p) => p.observedAt);
    expect(new Set(timesBefore).size).toBe(10); // genuinely distinct to begin with

    await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());
    const after = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    expect(after!.picks.map((p) => p.observedAt)).toEqual(timesBefore);
  });

  it("keeps the FIRST observation time when a ledger restates a pick", async () => {
    // first-seen-wins: the ledger's own stamp is when the SNAPSHOT was taken,
    // not when the pick happened.
    await relay(3);
    const before = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    const firstTime = before!.picks[0]!.observedAt;

    await writeBatch("led", "2026-08-30T23:59:00.000Z", [
      {
        v: 1,
        seq: 900,
        epoch: 0,
        observedAt: "2026-08-30T23:59:00.000Z",
        transport: "ws",
        kind: "ledger",
        payload: before!.picks.map((p) => ({
          teamId: p.teamId,
          playerId: p.playerId,
          slot3: 0,
          overallPickNumber: p.overall,
        })),
      },
    ]);
    await runInDurableObject(stub(), (s: DraftSession) => s.nudge());

    const after = await runInDurableObject(stub(), (s: DraftSession) => s.snapshot());
    expect(after!.picks[0]!.observedAt).toBe(firstTime);
  });

  it("is a no-op on an unarmed session rather than inventing a draft", async () => {
    await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
    });
    const n = await runInDurableObject(stub(), (s: DraftSession) => s.rebuild());
    expect(n).toBe(0);
  });
});

// --- WebSocket delivery ------------------------------------------------------

function upgrade(query = ""): Request {
  return new Request(`https://do/stream${query}`, { headers: { Upgrade: "websocket" } });
}

/**
 * Upgrade through the STUB, not `runInDurableObject`.
 *
 * The runtime refuses to return a WebSocket from an invocation whose own
 * request was not an upgrade, and `runInDurableObject` calls the method
 * directly — so the socket has to travel the real path.
 */
function open(query = ""): Promise<Response> {
  return stub().fetch(upgrade(query));
}

/** Read the frames a socket was sent, without a live client. */
function framesOf(res: Response): Promise<Record<string, unknown>[]> {
  const ws = res.webSocket!;
  const out: Record<string, unknown>[] = [];
  ws.accept();
  ws.addEventListener("message", (e) => out.push(JSON.parse(String((e as MessageEvent).data))));
  // Frames sent before accept() are buffered and delivered on the next tick.
  return new Promise((resolve) => setTimeout(() => resolve(out), 50));
}

async function snapshotEpoch(res: Response): Promise<string> {
  const frames = await framesOf(res);
  return String(frames.find((f) => f.type === "snapshot")?.epoch ?? "");
}

describe("stream delivery and reconnect (T036)", () => {
  it("always opens with a snapshot", async () => {
    await relay(3);
    const frames = await framesOf(await open());
    expect(frames[0]!.type).toBe("snapshot");
  });

  it("serves a reconnecting client a COMPLETE snapshot — zero missing picks", async () => {
    await relay(10);
    const frames = await framesOf(await open());
    const snap = frames.find((f) => f.type === "snapshot") as { state: { picks: unknown[] } };
    expect(snap.state.picks).toHaveLength(10);
  });

  it("replays only events AFTER a same-epoch cursor", async () => {
    await relay(6);
    const opening = await framesOf(await open());
    const epoch = String(opening.find((f) => f.type === "snapshot")!.epoch);
    const seq = Number(opening.find((f) => f.type === "snapshot")!.seq);

    await relay(2, 7); // two more picks land while the client is away

    const frames = await framesOf(await open(`?since=${seq}&epoch=${epoch}`));
    const events = frames.filter((f) => f.type === "event");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(Number(e.seq)).toBeGreaterThan(seq);
  });

  it("resets a cursor from a DIFFERENT epoch instead of replaying into it", async () => {
    await relay(6);
    const frames = await framesOf(await open("?since=1&epoch=00000000-0000-4000-8000-000000000000"));
    expect(frames[0]!.type).toBe("snapshot");
    expect(frames.filter((f) => f.type === "event")).toHaveLength(0);
  });

  it("treats an out-of-window cursor as a reset, not an error", async () => {
    // Rule 2: a cursor older than the retained window is not a failure. The
    // client gets a full snapshot and carries on.
    await relay(6);
    const frames = await framesOf(await open("?since=999999"));
    expect(frames[0]!.type).toBe("snapshot");
  });

  it("refuses the upgrade on a non-websocket request rather than 500ing", async () => {
    const res = await stub().fetch(new Request("https://do/stream"));
    expect(res.status).toBe(426);
  });

  it("refuses to stream an unarmed session", async () => {
    await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
      await state.storage.deleteAll();
    });
    const res = await stub().fetch(upgrade());
    expect(res.status).toBe(409);
  });
});
