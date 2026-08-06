// 008 T020–T031 — admit a live-observed draft into the corpus.
//
//   npx tsx scripts/lab-admit.ts --league <espnLeagueId> --season 2026 \
//     --class real|test [--local]
//
// Reads the retained relay frames, folds them through the EXISTING pure
// pipeline — `foldBatches()` then `reconcile()` — snapshots the engine inputs,
// screens, and writes two fixtures.
//
// IT DOES NOT USE 005's ARCHIVE PATH, deliberately. That path has written zero
// rows in production and is gated on two unfinished items (draft-end detection,
// keeper reconciliation). For a FINISHED draft none of that matters: every
// frame is already on disk, and the end of the file is the end of the draft.
//
// NO SECOND DECODER. The temptation is to parse relay payloads directly here.
// 010's oracle caught a wrong reading of `SELECTED`'s third field that agreed
// with the truth on 5 of 70 picks — a second decoder is a second chance to make
// that mistake with nothing to catch it.
//
// EVERY QUERY IS A SELECT. Snapshotting must never alter, delete or "preserve"
// anything in 002's or 004's tables: the design won over exempting seasons from
// the prune precisely because it is ADDITIVE. `tests/lab/boundary.test.ts`
// asserts that by reading this file.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { foldBatches, type FeedBatch, type RelayMessage } from "../src/draft/feed";
import { initialState, reconcile, type DraftState } from "../src/draft/reconcile";
import { buildLeagueBoard } from "../src/projections/scoring";
import { detectAdpFloor } from "../src/projections/adpFloor";
import { bundleToSnapshot, canonicalJson } from "../src/lab/codec";
import { chooseSetAt, type CandidateSet } from "../src/lab/setChoice";
import { CORPUS_FORMAT_VERSION, validateEntry, type CorpusEntry, type CorpusPick } from "../src/lab/corpus";
import { memberNamesIn } from "./sanitize-espn";
import type { EngineBundle, SignalKind, SignalValue } from "../src/engine/types";
import type { RosterSnapshot, ScoringSnapshot } from "../src/espn/parsers";

const FIXTURES = "tests/fixtures/lab";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const remote = process.argv.includes("--local") ? [] : ["--remote"];

/** One read against D1 via wrangler, same shape `export-tap-corpus.ts` uses. */
function query<T>(sql: string): T[] {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "draft-genie", ...remote, "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const match = /\[\s*\{[\s\S]*\}\s*\]/.exec(raw);
  if (!match) throw new Error("could not parse wrangler output");
  return ((JSON.parse(match[0]) as { results?: T[] }[])[0]?.results ?? []) as T[];
}

/** SQL string literal escaping. Ids are numeric-ish, but never trust that. */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function main(): void {
  const league = arg("league");
  const season = Number(arg("season") ?? "2026");
  const cls = arg("class");

  if (!league || (cls !== "real" && cls !== "test")) {
    console.error("usage: npx tsx scripts/lab-admit.ts --league <espnLeagueId> --season 2026 --class real|test [--local]");
    console.error("");
    console.error("  --class is REQUIRED and has no default. A mock draft replays perfectly and");
    console.error("  is still not evidence: the room did not behave the way a real room behaves,");
    console.error("  so tuning against one fits noise. Misclassifying it contaminates every");
    console.error("  comparison afterwards, and nothing downstream can detect it.");
    process.exit(2);
  }

  // ---- 1. the frames -----------------------------------------------------
  const batchRows = query<{
    id: string;
    account_id: string;
    connection_id: string;
    received_at: string;
    install_id: string;
    session_id: string;
    first_seq: number;
    last_seq: number;
    messages_json: string;
  }>(
    `SELECT id, account_id, connection_id, received_at, install_id, session_id, first_seq, last_seq, messages_json
     FROM tap_batches WHERE espn_league_id = ${q(league)} AND season = ${season}
     ORDER BY received_at, id`,
  );

  if (batchRows.length === 0) {
    console.error(`no retained frames for league ${league}, season ${season}`);
    process.exit(1);
  }

  // Per-user isolation (FR-027) enforced by scoping every later query to the
  // account these frames belong to, in the query itself rather than by a
  // comparison at a call site someone can forget.
  const accountId = batchRows[0]!.account_id;
  const connectionId = batchRows[0]!.connection_id;
  if (batchRows.some((b) => b.account_id !== accountId)) {
    throw new Error("frames span more than one account — refusing to mix them");
  }

  const batches: FeedBatch[] = batchRows.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    installId: r.install_id,
    sessionId: r.session_id,
    firstSeq: r.first_seq,
    lastSeq: r.last_seq,
    messages: JSON.parse(r.messages_json) as RelayMessage[],
  }));

  // ---- 2. league shape ---------------------------------------------------
  const snapRow = query<{ scoring_json: string; roster_json: string; draft_json: string; teams_json: string; my_team_id: number | null }>(
    `SELECT scoring_json, roster_json, draft_json, teams_json, my_team_id
     FROM league_snapshots WHERE connection_id = ${q(connectionId)}`,
  )[0];
  if (!snapRow) throw new Error(`no league snapshot for connection ${connectionId}`);

  const scoring = JSON.parse(snapRow.scoring_json) as ScoringSnapshot;
  const roster = JSON.parse(snapRow.roster_json) as RosterSnapshot;
  const draft = JSON.parse(snapRow.draft_json) as { order: number[] | null; scheduled_at: string | null };
  const teams = JSON.parse(snapRow.teams_json) as unknown[];
  const teamCount = Array.isArray(teams) ? teams.length : 0;
  const roundCount = roster.slots.reduce((n, s) => n + s.count, 0);

  // ---- 3. reconcile ------------------------------------------------------
  const observation = foldBatches(null, batches);
  let state: DraftState = initialState({
    order: draft.order ?? [],
    myTeamId: snapRow.my_team_id,
    totalPicks: teamCount * roundCount,
  });
  state = reconcile(state, observation).state;

  const picks: CorpusPick[] = state.picks
    .slice()
    .sort((a, b) => a.overall - b.overall)
    .map((p) => {
      const round = teamCount > 0 ? Math.ceil(p.overall / teamCount) : 0;
      const idx = teamCount > 0 ? (p.overall - 1) % teamCount : 0;
      return {
        overall: p.overall,
        round,
        roundPick: idx + 1,
        teamId: p.teamId,
        // NEVER filtered on sign — `-1` is the empty-slot sentinel, D/ST ids
        // sit near −16000, and `playerId > 0` is what made 010's capture
        // report 66 of 72 picks for a complete draft.
        playerId: p.playerId,
        keeper: false,
        autodrafted: false,
        observedAt: p.observedAt,
        observedEpoch: p.epoch,
      };
    });

  const totalPicks = teamCount * roundCount;
  const seen = new Set(picks.map((p) => p.overall));
  const gaps: number[] = [];
  for (let n = 1; n <= totalPicks; n++) if (!seen.has(n)) gaps.push(n);

  // ---- 4. the snapshot ---------------------------------------------------
  const startedAt = picks[0]?.observedAt ?? draft.scheduled_at ?? null;
  const sets = query<CandidateSet>(
    `SELECT id, status, fetched_at, season FROM projection_sets WHERE season = ${season} ORDER BY fetched_at`,
  );
  const chosen = chooseSetAt(sets, startedAt);

  let bundle: EngineBundle | null = null;
  let unreplayable: string | null = null;

  if (!chosen) {
    // FR-019d / FR-016: no substitute. A board published after a draft already
    // reflects what happened in it.
    unreplayable = `no complete projection set predates ${startedAt ?? "an unknown start time"}`;
  } else if (gaps.length > 0) {
    unreplayable = `${gaps.length} pick(s) missing from the retained frames (${gaps.slice(0, 6).join(", ")}${gaps.length > 6 ? "…" : ""})`;
  } else if (snapRow.my_team_id === null) {
    unreplayable = "the owner's team is unknown, so there are no owner turns";
  } else if (!draft.order || draft.order.length === 0) {
    unreplayable = "the draft order was never published, and it is never guessed";
  } else {
    const universe = query<{ espn_player_id: number; name: string; position: string; eligible_positions: string; pro_team_id: number; team_abbrev: string | null; bye_week: number | null }>(
      `SELECT p.*, t.abbrev AS team_abbrev, t.bye_week FROM players p
       LEFT JOIN pro_teams t ON t.espn_team_id = p.pro_team_id WHERE p.active = 1`,
    );
    const setRows = query<{ espn_player_id: number; stats_json: string; adp: number | null; overall_rank: number | null }>(
      `SELECT espn_player_id, stats_json, adp, overall_rank FROM player_projections WHERE set_id = ${q(chosen.id)}`,
    );
    const signalRows = query<{ kind: string; pro_team_id: number; raw_value: number; score: number; rank: number; provenance: string; computed_at: string }>(
      `SELECT kind, pro_team_id, raw_value, score, rank, provenance, computed_at FROM signal_entries`,
    );
    const preferredRows = query<{ espn_player_id: number }>(
      `SELECT espn_player_id FROM preferred_players
       WHERE account_id = ${q(accountId)} AND connection_id = ${q(connectionId)} AND season = ${season}`,
    );

    const players = buildLeagueBoard(universe as never, setRows as never, scoring.items);
    const signals = new Map<SignalKind, Map<number, SignalValue>>();
    const signalFreshness = new Map<SignalKind, { computedAt: string; provenance: string }>();
    for (const r of signalRows) {
      const kind = r.kind as SignalKind;
      if (!signals.has(kind)) signals.set(kind, new Map());
      signals.get(kind)!.set(r.pro_team_id, {
        raw_value: r.raw_value,
        score: r.score,
        rank: r.rank,
        provenance: r.provenance,
        computed_at: r.computed_at,
      });
      signalFreshness.set(kind, { computedAt: r.computed_at, provenance: r.provenance });
    }

    bundle = {
      players,
      signals,
      proTeamByPlayer: new Map(universe.map((p) => [p.espn_player_id, p.pro_team_id])),
      roster,
      teamCount,
      preferred: new Set(preferredRows.map((p) => p.espn_player_id)),
      adpFloor: detectAdpFloor(setRows.map((r) => r.adp)),
      freshness: { fetchedAt: chosen.fetched_at, stale: false },
      signalFreshness,
    };
  }

  // ---- 5. the entry ------------------------------------------------------
  const entry: CorpusEntry = {
    formatVersion: CORPUS_FORMAT_VERSION,
    id: `${league}-${season}`,
    season,
    espnLeagueId: league,
    provenance: "live_frames",
    provenanceClass: cls,
    useClass: bundle ? "replayable" : "pick_sequence_only",
    unreplayableReason: unreplayable,
    teamCount,
    roundCount,
    totalPicks,
    myTeamId: snapRow.my_team_id,
    order: draft.order ?? [],
    picks,
    keepers: [],
    startedAt,
    completedAt: picks[picks.length - 1]?.observedAt ?? startedAt ?? "",
    oracle: null,
    gaps,
  };

  // ---- 6. screen, THEN write --------------------------------------------
  // Before the write, never after. `privacy-sweep.ts` is the backstop; this is
  // the gate. Its own history is the argument: a post-hoc sweep once printed
  // "clean" over two fixtures full of real member names.
  const entryText = canonicalJson(entry);
  const snapText = bundle
    ? canonicalJson(
        bundleToSnapshot(bundle, {
          entryId: entry.id,
          sourceSetId: chosen!.id,
          sourceSetFetchedAt: chosen!.fetched_at,
        }),
      )
    : null;

  for (const [what, text] of [["entry", entryText], ["snapshot", snapText]] as const) {
    if (!text) continue;
    if (/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.test(text)) {
      console.error(`refusing to write: ${what} contains an identifier`);
      process.exit(1);
    }
    if (/https?:\/\//.test(text)) {
      console.error(`refusing to write: ${what} contains a URL`);
      process.exit(1);
    }
    const names = memberNamesIn(text);
    if (names.length > 0) {
      console.error(`refusing to write: ${what} contains ${names.length} member name(s)`);
      process.exit(1);
    }
  }

  const violations = validateEntry(entry, snapText !== null);
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v.invariant}: ${v.detail}`);
    process.exit(1);
  }

  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(`${FIXTURES}/${entry.id}.draft.json`, entryText);
  if (snapText) writeFileSync(`${FIXTURES}/${entry.id}.inputs.json`, snapText);

  console.log(`\nadmitted ${entry.id} — ${picks.length} picks, class ${cls}, ${entry.useClass}`);
  if (unreplayable) console.log(`  unreplayable: ${unreplayable}`);
  if (chosen) console.log(`  board from set ${chosen.id} (fetched ${chosen.fetched_at})`);
  // Stated, never implied: signals are overwritten in place and have no
  // history, so a draft admitted after the fact can never recover its own.
  console.log(`  fidelity: board as_of, signals present_day (signal_entries has no history)\n`);
}

main();
