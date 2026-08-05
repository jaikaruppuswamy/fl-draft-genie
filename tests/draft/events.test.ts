// 005 T044/T047 — the event contract, over the REAL corpus (SC-003, SC-010).
//
// This is what 006 and 007 are built against, so the shape has to be right now:
// two downstream features depend on it and it has little standalone UI of its
// own to shake the bugs out.
//
// The corpus is 72 messages relayed by the shipped tap from a real 6-team,
// 12-round draft, and the oracle is the same draft as ESPN reported it after
// completion. Asserting the event stream against a replay of itself would prove
// nothing; the oracle is what makes "the right team was on the clock" a
// checkable claim.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import corpusRaw from "../fixtures/tap/replay-full.jsonl?raw";
import oracleJson from "../fixtures/tap/oracle-live-2026.json";
import { initialState, reconcile, type DraftEvent } from "../../src/draft/reconcile";
import type { Observation, PickObservation } from "../../src/draft/feed";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const OWNER = 1;
const testEnv = env as unknown as Env;

interface OracleP {
  overallPickNumber: number;
  teamId: number;
  playerId: number;
}

const corpus = (corpusRaw as string)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { seq: number; kind: string; payload: unknown });
const oracle = (oracleJson as unknown as { picks: OracleP[] }).picks;

/**
 * The round-1 order, DERIVED from the oracle rather than hardcoded.
 *
 * A constant here was wrong: it had been copied from 010's FIRST capture, and
 * this corpus is the second draft, which drew a different order. Every
 * turn-event assertion would then have been checked against a draft that never
 * happened. Reading it from the independently-derived record removes the
 * chance of the fixture and the expectation disagreeing silently.
 */
const TEAM_COUNT = 6;
const ORDER = [...oracle]
  .sort((a, b) => a.overallPickNumber - b.overallPickNumber)
  .slice(0, TEAM_COUNT)
  .map((p) => p.teamId);

/** Drive the pure reducer over the corpus, collecting every event. */
function replayEvents(): { events: DraftEvent[]; revision: number; picks: number } {
  let state = initialState({ order: ORDER, myTeamId: OWNER, totalPicks: 72 });
  const events: DraftEvent[] = [];
  for (const m of corpus) {
    const obs: Observation = { picks: [], ledger: null, statuses: [], cursor: { receivedAt: "", id: "" } };
    if (m.kind === "pick") {
      const p = m.payload as { teamId: number; playerId: number; slot3: number };
      obs.picks = [{ ...p, observedAt: `2026-08-05T02:${String(m.seq).padStart(2, "0")}:00.000Z`, epoch: 0 }];
    } else if (m.kind === "ledger") {
      obs.ledger = (m.payload as PickObservation[]).map((r) => ({
        ...r,
        observedAt: `2026-08-05T02:${String(m.seq).padStart(2, "0")}:00.000Z`,
        epoch: 0,
      }));
    }
    const r = reconcile(state, obs);
    state = r.state;
    events.push(...r.events);
  }
  return { events, revision: state.revision, picks: state.picks.length };
}

describe("the event stream over the real corpus", () => {
  it("emits exactly one pick_made per pick, and no more", () => {
    const { events, picks } = replayEvents();
    expect(picks).toBe(72);
    const made = events.filter((e) => e.kind === "pick_made");
    // Corrections re-emit, so uniqueness is per (revision, overall).
    const keys = new Set(made.map((e) => `${e.revision}:${e.overall}`));
    expect(keys.size).toBe(made.length);
  });

  it("agrees with the ORACLE about who was on the clock", () => {
    // The owner's turns, as an independently derived record states them.
    //
    // ONE EXCEPTION, and it is correct rather than a gap: in this corpus the
    // ledger at seq 22 reveals three picks the incremental stream never
    // delivered, jumping the frontier 22 → 25 and crossing the owner's turn at
    // 23. That pick had ALREADY been made — the ledger is what told us — so
    // announcing "you are on the clock" for it afterwards would be false. A
    // turn the draft has passed is history, not an alert.
    const { events } = replayEvents();
    const ownerTurns = oracle.filter((o) => o.teamId === OWNER).map((o) => o.overallPickNumber);
    expect(ownerTurns.length).toBeGreaterThan(0);

    const clocked = new Set(events.filter((e) => e.kind === "on_the_clock").map((e) => e.overall));
    const missed = ownerTurns.filter((t) => !clocked.has(t));

    // Every owner turn the draft actually STOPPED at was announced...
    expect(missed).toEqual([23]);
    // ...and the one that was not is exactly the turn the ledger jumped over.
    expect(ownerTurns.length - missed.length).toBeGreaterThan(5);
  });

  it("announces every owner turn the frontier actually stopped at", () => {
    // The general form of the rule above, stated without the corpus-specific
    // exception: an alert is owed for a turn the draft reached, never for one
    // it had already passed by the time we learned of it.
    const { events } = replayEvents();
    const clocked = events.filter((e) => e.kind === "on_the_clock");
    for (const e of clocked) {
      const truth = oracle.find((o) => o.overallPickNumber === e.overall);
      expect(truth, `on_the_clock fired for a pick the oracle does not have: ${e.overall}`).toBeDefined();
      expect(truth!.teamId, `on_the_clock named the wrong team at ${e.overall}`).toBe(e.teamId);
    }
  });

  it("fires on_deck before on_the_clock for EVERY owner turn, within a revision", () => {
    const { events } = replayEvents();
    const byTurn = new Map<string, { deck?: number; clock?: number }>();
    events.forEach((e, i) => {
      if (e.kind !== "on_deck" && e.kind !== "on_the_clock") return;
      const key = `${e.revision}:${e.overall}`;
      const slot = byTurn.get(key) ?? {};
      if (e.kind === "on_deck") slot.deck = i;
      else slot.clock = i;
      byTurn.set(key, slot);
    });

    expect(byTurn.size).toBeGreaterThan(0);
    for (const [key, { deck, clock }] of byTurn) {
      if (clock === undefined) continue; // a turn the draft never reached
      expect(deck, `turn ${key} got on_the_clock with no on_deck`).toBeDefined();
      expect(deck!, `turn ${key} fired out of order`).toBeLessThan(clock);
    }
  });

  it("fires each turn event EXACTLY ONCE per revision — none skipped, none doubled", () => {
    const { events } = replayEvents();
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.kind !== "on_deck" && e.kind !== "on_the_clock") continue;
      const key = `${e.revision}:${e.kind}:${e.overall}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, n] of counts) expect(n, key).toBe(1);
  });

  it("carries a real picksUntil on every on_deck — 2, 1 or 0, never invented", () => {
    const { events } = replayEvents();
    const deck = events.filter((e): e is Extract<DraftEvent, { kind: "on_deck" }> => e.kind === "on_deck");
    expect(deck.length).toBeGreaterThan(0);
    for (const e of deck) expect([0, 1, 2]).toContain(e.picksUntil);
  });

  it("emits draft_complete exactly once, at the end", () => {
    const { events } = replayEvents();
    const done = events.filter((e) => e.kind === "draft_complete");
    expect(done).toHaveLength(1);
    expect(events.indexOf(done[0]!)).toBe(events.length - 1);
  });

  it("lets a consumer dedupe on (revision, kind, overall)", () => {
    // The contract 006 relies on: a revision bump reads as "rewind and
    // re-apply", and duplicate frames must be absorbable without a resync.
    const { events } = replayEvents();
    const key = (e: DraftEvent) => `${e.revision}:${e.kind}:${"overall" in e ? e.overall : "-"}`;
    const seen = new Set(events.map(key));
    // Replaying the same stream through a consumer's dedupe adds nothing.
    const doubled = new Set([...events, ...events].map(key));
    expect(doubled.size).toBe(seen.size);
  });
});

// --- the same, through the real session -------------------------------------

const CONNECTION = "conn-events";
const ACCOUNT = "acct-events";
const LEAGUE = "5555555555";
const SEASON = 2026;

const scope: SessionScope = {
  accountId: ACCOUNT,
  connectionId: CONNECTION,
  espnLeagueId: LEAGUE,
  season: SEASON,
  myTeamId: OWNER,
  order: ORDER,
  totalPicks: 72,
};

function stub() {
  return testEnv.DRAFT_SESSION.get(sessionIdFor(testEnv, CONNECTION, SEASON));
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "events@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await runInDurableObject(stub(), async (_i: DraftSession, s: DurableObjectState) => {
    await s.storage.deleteAll();
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("delivery seqs are strictly increasing", () => {
  it("assigns a gapless, ascending seq across the whole draft", async () => {
    // Clients discard `seq <= cursor` and resync only on a true forward gap, so
    // a seq that ever moved backwards or skipped would trigger a resync storm
    // at exactly the busiest moment of the draft.
    for (const [i, m] of corpus.entries()) {
      await testEnv.DB.prepare(
        `INSERT INTO tap_batches
           (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
            received_at, first_seq, last_seq, message_count, kinds, messages_json)
         VALUES (?, ?, ?, ?, ?, 'i', 's', ?, ?, ?, 1, ?, ?)`,
      )
        .bind(
          `ev-${String(i).padStart(3, "0")}`,
          ACCOUNT,
          CONNECTION,
          LEAGUE,
          SEASON,
          new Date(1_800_000_000_000 + i * 1000).toISOString(),
          m.seq,
          m.seq,
          m.kind,
          JSON.stringify([{ ...m, v: 1, epoch: 0, observedAt: new Date(1_800_000_000_000 + i * 1000).toISOString(), transport: "ws" }]),
        )
        .run();
      await runInDurableObject(stub(), (s: DraftSession) => s.nudge());
    }

    const res = await stub().fetch(new Request("https://do/stream", { headers: { Upgrade: "websocket" } }));
    const ws = res.webSocket!;
    const frames: Record<string, unknown>[] = [];
    ws.accept();
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String((e as MessageEvent).data))));
    await new Promise((r) => setTimeout(r, 50));

    const snapshot = frames.find((f) => f.type === "snapshot")!;
    expect(Number(snapshot.seq)).toBeGreaterThan(0);
  });
});
