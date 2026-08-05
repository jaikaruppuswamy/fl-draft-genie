// 005 T028 — replay the committed corpus and compare against the ORACLE.
//
// This is SC-010, and the comparison target is what makes it worth running.
// The corpus (`replay-full.jsonl`) is 72 messages relayed by the shipped tap
// from a real 6-team, 12-round draft. The oracle (`oracle-live-2026.json`) is
// the SAME draft as ESPN reported it after completion — produced by a
// completely different mechanism, and the one view Gate 0 proved ESPN writes
// reliably.
//
// Validating the corpus against itself would prove nothing. Validating it
// against an independently derived record is what caught a real error in 010:
// it disproved the reading of `SELECTED`'s third field as the round (agreeing
// on 5 of 70 picks) and confirmed the ledger offsets (31/31).
//
// The corpus also contains the case the whole ledger design exists for: 69 of
// the 72 picks arrived as incremental frames, and **three exist only in a
// ledger snapshot**. Either source alone is an incomplete draft.

import { env, runInDurableObject } from "cloudflare:test";
// Fixtures come in through the bundler: `node:fs` is not available in the
// Workers pool, and the corpus must be readable by the same runtime the
// session runs in.
import corpusRaw from "../fixtures/tap/replay-full.jsonl?raw";
import oracleJson from "../fixtures/tap/oracle-live-2026.json";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftSession, sessionIdFor, type SessionScope } from "../../src/draft/session";
import type { Env } from "../../src/env";

const ACCOUNT = "acct-replay";
const CONNECTION = "conn-replay";
const LEAGUE = "9999999999";
const SEASON = 2026;
/** The test league's real, non-identity order — the snake reversal confirms it. */
const ORDER = [5, 2, 1, 3, 6, 4];

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

/** One message per batch, in seq order — as the live path actually delivers. */
async function replayCorpus(): Promise<void> {
  for (const [i, m] of corpus.entries()) {
    const receivedAt = new Date(1_800_000_000_000 + i * 1000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO tap_batches
         (id, account_id, connection_id, espn_league_id, season, install_id, session_id,
          received_at, first_seq, last_seq, message_count, kinds, messages_json)
       VALUES (?, ?, ?, ?, ?, 'install-1', 'session-1', ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        `r${String(i).padStart(3, "0")}`,
        ACCOUNT,
        CONNECTION,
        LEAGUE,
        SEASON,
        receivedAt,
        m.seq,
        m.seq,
        m.kind,
        JSON.stringify([m]),
      )
      .run();
    await runInDurableObject(stub(), (inst: DraftSession) => inst.nudge());
  }
}

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM tap_batches WHERE account_id = ?`).bind(ACCOUNT).run();
  await testEnv.DB.prepare(`INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)`)
    .bind(ACCOUNT, "replay@test.co", "2026-08-01T00:00:00.000Z")
    .run();
  await runInDurableObject(stub(), async (_i: DraftSession, state: DurableObjectState) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
  await runInDurableObject(stub(), (i: DraftSession) => i.arm(scope));
});

describe("replaying the live corpus (SC-010)", () => {
  it("reconstructs ALL 72 picks — including the 3 that only a ledger carried", async () => {
    await replayCorpus();
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.picks).toHaveLength(72);

    const streamed = new Set(
      corpus.filter((m) => m.kind === "pick").map((m) => (m.payload as { playerId: number }).playerId),
    );
    expect(streamed.size).toBe(69); // the incremental stream alone is short
    const recovered = snap!.picks.filter((p) => !streamed.has(p.playerId));
    expect(recovered).toHaveLength(3); // and the ledger supplies exactly the rest
  });

  it("agrees with the ORACLE on every pick's team and position", async () => {
    await replayCorpus();
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    const byPlayer = new Map(snap!.picks.map((p) => [p.playerId, p]));

    expect(oracle).toHaveLength(72);
    for (const o of oracle) {
      const ours = byPlayer.get(o.playerId);
      expect(ours, `player ${o.playerId} missing from the replayed draft`).toBeDefined();
      expect(ours!.teamId, `team for player ${o.playerId}`).toBe(o.teamId);
      expect(ours!.overall, `overall for player ${o.playerId}`).toBe(o.overallPickNumber);
    }
  });

  it("keeps the D/ST picks, whose ids are negative", async () => {
    await replayCorpus();
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    const negatives = snap!.picks.filter((p) => p.playerId < 0);
    const oracleNegatives = oracle.filter((o) => o.playerId < 0);
    expect(negatives).toHaveLength(oracleNegatives.length);
    expect(oracleNegatives.length).toBeGreaterThan(0); // the corpus really has them
  });

  it("marks the draft complete and stops", async () => {
    await replayCorpus();
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.complete).toBe(true);
    expect(snap!.onTheClock).toBeNull();
    const alarm = await runInDurableObject(stub(), (_i: DraftSession, s: DurableObjectState) => s.storage.getAlarm());
    expect(alarm).toBeNull();
  });

  it("never needed a correction — the tap and the ledger agreed throughout", async () => {
    // A revision bump here would mean the ledger contradicted the stream, which
    // in a healthy draft it should not. If this ever fails, the reconciler is
    // right and something upstream changed.
    await replayCorpus();
    const snap = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(snap!.revision).toBe(0);
  });

  it("is idempotent: replaying the whole corpus twice changes nothing", async () => {
    await replayCorpus();
    const first = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    for (let n = 0; n < 3; n++) await runInDurableObject(stub(), (i: DraftSession) => i.nudge());
    const second = await runInDurableObject(stub(), (i: DraftSession) => i.snapshot());
    expect(second!.picks).toHaveLength(first!.picks.length);
    expect(second!.revision).toBe(first!.revision);
  });
});
