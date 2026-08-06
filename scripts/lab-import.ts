// 008 T041–T048 — import a completed draft from ESPN.
//
//   ESPN_S2='...' SWID='{...}' npx tsx scripts/lab-import.ts \
//     --league <espnLeagueId> --season <year> --class real|test
//
// TWO DIFFERENT JOBS, and confusing them is the mistake this file exists to
// prevent:
//
//   season the pipeline covers  → matched to the set serving at draft time,
//                                 snapshotted, REPLAYABLE
//   any earlier season          → PICK-SEQUENCE-ONLY, permanently unreplayable
//
// A 2024 board does not exist and cannot be fetched at any price — ESPN serves
// preseason projections for the current season only. Running the engine over a
// 2024 pick sequence against a 2026 board would produce numbers that look like
// evidence and are not, so the entry is marked and the replay refuses it
// structurally.
//
// READ-ONLY (Constitution VI). This asks for a draft that has already finished
// — the one view 005's Gate 0 proved ESPN writes reliably. No draft-room
// connection, no JOIN, no write of any kind.
//
// Whether past seasons are readable AT ALL is Gate 0's question
// (scripts/lab-gate0.ts). Run that first.

import { writeFileSync, mkdirSync } from "node:fs";
import { parseCompletedDraft } from "../src/espn/parsers";
import { canonicalJson } from "../src/lab/codec";
import { CORPUS_FORMAT_VERSION, validateEntry, type CorpusEntry, type CorpusPick } from "../src/lab/corpus";
import { memberNamesIn } from "./sanitize-espn";
import type { EspnLeagueResponse } from "../src/espn/types";

const FIXTURES = "tests/fixtures/lab";
const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/**
 * Fetch a completed draft, trying the current-season path then leagueHistory.
 *
 * ESPN serves prior seasons from `/leagueHistory/{id}?seasonId=`, which returns
 * an ARRAY rather than an object. Gate 0 exists to establish which form works;
 * this handles both so the import is not the place that discovers it.
 */
async function fetchDraft(league: string, season: number, cookie: string): Promise<EspnLeagueResponse> {
  const views = "view=mDraftDetail&view=mSettings&view=mTeam";
  const urls = [
    `${BASE}/seasons/${season}/segments/0/leagues/${encodeURIComponent(league)}?${views}`,
    `${BASE}/leagueHistory/${encodeURIComponent(league)}?seasonId=${season}&${views}`,
  ];
  let lastStatus = 0;
  for (const url of urls) {
    // GET only. There is no write path in this product.
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json", Cookie: cookie } });
    lastStatus = res.status;
    if (!res.ok) continue;
    const doc = (await res.json()) as unknown;
    const one = Array.isArray(doc) ? (doc[0] as EspnLeagueResponse | undefined) : (doc as EspnLeagueResponse);
    if (one?.draftDetail?.picks?.length) return one;
  }
  // The URL is deliberately absent from the message: it carries the league id.
  throw new Error(`no completed draft returned for season ${season} (last status ${lastStatus})`);
}

async function main(): Promise<void> {
  const league = arg("league");
  const season = Number(arg("season") ?? "0");
  const cls = arg("class");
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.SWID;
  // Seasons the projections pipeline has covered. Anything earlier has no
  // board and can never be replayed.
  const coveredFrom = Number(arg("covered-from") ?? "2026");

  if (!league || !season || (cls !== "real" && cls !== "test") || !espnS2 || !swid) {
    console.error("usage: ESPN_S2='...' SWID='{...}' npx tsx scripts/lab-import.ts --league <id> --season <year> --class real|test");
    console.error("");
    console.error("  --class is REQUIRED and has no default: a mock draft replays perfectly and is");
    console.error("  still not evidence, and misclassifying one contaminates every later comparison.");
    process.exit(2);
  }

  const doc = await fetchDraft(league, season, `espn_s2=${espnS2}; SWID=${swid}`);

  // Snake only, matching 005. An auction imported as though the order were a
  // snake would be wrong in a way nothing downstream could detect.
  const draftType = (doc.settings?.draftSettings as { type?: string } | undefined)?.type;
  if (draftType && !/SNAKE|OFFLINE/i.test(draftType)) {
    console.error(`refusing to import: draft type ${draftType} is not a snake`);
    process.exit(1);
  }

  const completed = parseCompletedDraft(doc);
  if (completed.length === 0) {
    console.error("refusing to import: no picks in the response");
    process.exit(1);
  }

  const teams = Array.isArray(doc.teams) ? doc.teams.length : 0;
  const roundCount = teams > 0 ? Math.ceil(completed.length / teams) : 0;

  const picks: CorpusPick[] = completed.map((p) => ({
    overall: p.overall,
    round: p.round,
    roundPick: p.roundPick,
    teamId: p.teamId,
    playerId: p.playerId,
    keeper: p.keeper,
    autodrafted: p.autodrafted,
    // The one thing an import cannot supply: ESPN's post-completion flush
    // stamps every pick with the same time, so per-pick timing is lost.
    observedAt: null,
    observedEpoch: null,
  }));

  // Keepers on EVERY team, not only the owner's (FR-024). In some leagues
  // keepers never arrive as picks at all.
  const keepers = completed.filter((p) => p.keeper).map((p) => ({ teamId: p.teamId, playerId: p.playerId }));

  const replayable = season >= coveredFrom;
  const order = [...new Set(picks.filter((p) => p.round === 1).sort((a, b) => a.overall - b.overall).map((p) => p.teamId))];

  const entry: CorpusEntry = {
    formatVersion: CORPUS_FORMAT_VERSION,
    id: `${league}-${season}`,
    season,
    espnLeagueId: league,
    provenance: "espn_import",
    provenanceClass: cls,
    // Snapshotting a covered season is `lab-admit.ts`'s job once the board is
    // matched; import alone cannot produce one, so an entry starts as a pick
    // sequence and is promoted only when a snapshot is written beside it.
    useClass: "pick_sequence_only",
    unreplayableReason: replayable
      ? "imported without a snapshot — run lab-admit to attach the board that was serving at draft time"
      : `the projections pipeline never covered ${season}; no board for that season exists or can be fetched`,
    teamCount: teams,
    roundCount,
    totalPicks: picks.length,
    // Derived from the picks themselves — a historical draft may have no
    // published order at all.
    myTeamId: null,
    order,
    picks,
    keepers,
    startedAt: null,
    completedAt: "",
    oracle: null,
    gaps: [],
  };

  // Screen BEFORE writing. The authenticated response carries `members[]` with
  // real names and SWIDs for every manager in the league; none of it may reach
  // a file (FR-021). `memberNamesIn` is imported rather than reimplemented —
  // `privacy-sweep.ts` records what happened when this logic was copied.
  const text = canonicalJson(entry);
  if (/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.test(text)) {
    console.error("refusing to write: entry contains an identifier");
    process.exit(1);
  }
  if (/https?:\/\//.test(text)) {
    console.error("refusing to write: entry contains a URL");
    process.exit(1);
  }
  const names = memberNamesIn(text);
  if (names.length > 0) {
    console.error(`refusing to write: entry contains ${names.length} member name(s)`);
    process.exit(1);
  }

  const violations = validateEntry(entry, false);
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v.invariant}: ${v.detail}`);
    process.exit(1);
  }

  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(`${FIXTURES}/${entry.id}.draft.json`, text);

  console.log(`\nimported ${entry.id} — ${picks.length} picks, ${keepers.length} keeper(s), class ${cls}`);
  console.log(`  use class: ${entry.useClass}`);
  console.log(`  reason:    ${entry.unreplayableReason}`);
  if (!replayable) {
    console.log(`\n  This entry can never be replayed. Its value is the pick sequence itself:`);
    console.log(`  run lab-behaviour.ts to measure how this room drafted relative to ADP.\n`);
  } else {
    console.log("");
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
