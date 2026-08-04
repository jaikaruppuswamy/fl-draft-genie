// Gate 0 capture tool (005 T001/T002).
//
// Samples a real ESPN draft continuously and writes SANITIZED fixtures. The
// premise of feature 005 — that `mDraftDetail` reflects picks *during* a draft
// rather than flushing them at completion — is unverified (research §0), and
// this tool is what settles it.
//
// Read-only: it issues GETs through the same client the Worker uses. It never
// prints or writes the cookie pair, and it refuses to write any file that
// still contains a real GUID or manager name.
//
//   ESPN_S2='...' SWID='{...}' npx tsx scripts/capture-draft.ts \
//     --league 123456 --season 2026 [--interval 5000] [--once]
//
// Output (tests/fixtures/espn/draft/):
//   observations.jsonl  every sample, in order — the continuous sequence
//                       SC-003 and SC-010 are defined over
//   order|open|mid|complete.json   the four landmark full-view snapshots

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createEspnClient, type EspnView } from "../src/espn/client";
import type { Env } from "../src/env";
import { EspnError } from "../src/espn/types";
import { deriveMapping, mergeMapping, sanitize, assertClean, type Mapping } from "./sanitize-espn";

// ESPN accepts several `view=` params in ONE request, so capturing everything
// costs the same number of requests as capturing mDraftDetail alone — only the
// response is bigger. For a capture tool that is the right trade: if
// mDraftDetail turns out to be frozen during a live draft, the answer to "does
// ANY view reflect live picks?" is already in the recording.
const FULL_VIEWS: EspnView[] = ["mSettings", "mTeam", "mDraftDetail", "mRoster"];

interface Pick {
  playerId?: number;
  teamId?: number;
  roundId?: number;
  roundPickNumber?: number;
  overallPickNumber?: number;
  keeper?: boolean;
  autoDraftTypeId?: number;
  bidAmount?: number;
  nominatingTeamId?: number;
}
interface DraftResponse {
  settings?: { name?: string; size?: number; draftSettings?: { type?: string; pickOrder?: number[] } };
  members?: { id: string; displayName?: string; firstName?: string; lastName?: string }[];
  teams?: { id: number; name?: string; owners?: string[] }[];
  draftDetail?: { drafted?: boolean; inProgress?: boolean; picks?: Pick[] };
}

/** ESPN pre-populates a placeholder skeleton with `playerId: -1`. A real pick is
 *  anything else — including NEGATIVE ids near -16000, which are D/ST.
 *
 *  This previously read `playerId > 0`, which silently undercounted every draft
 *  by the number of D/ST taken (6 in a 6-team league: it reported 66/72 for a
 *  complete draft). That is the exact "never filter on sign" rule this project
 *  wrote into contracts/ingest.md after observing negative ids — violated here
 *  in our own tooling. Caught by cross-checking against the oracle. */
const SKELETON_PLAYER_ID = -1;
const filledPicks = (r: DraftResponse) =>
  (r.draftDetail?.picks ?? []).filter((p) => (p.playerId ?? SKELETON_PLAYER_ID) !== SKELETON_PLAYER_ID).length;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const league = arg("league");
  const season = Number(arg("season", String(new Date().getFullYear())));
  const interval = Number(arg("interval", "5000"));
  const outDir = arg("out", "tests/fixtures/espn/draft")!;
  const maxMinutes = Number(arg("max-minutes", "300"));
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.SWID;

  if (!league || !espnS2 || !swid) {
    console.error(
      "usage: ESPN_S2='...' SWID='{...}' npx tsx scripts/capture-draft.ts --league <id> [--season <y>] [--interval <ms>] [--once]",
    );
    process.exit(2);
  }
  if (interval < 2000) {
    console.error("refusing an interval under 2000 ms — FR-008 bounds our request rate against ESPN");
    process.exit(2);
  }

  const client = createEspnClient({} as Env, { espnS2, swid });
  await mkdir(outDir, { recursive: true });

  // First poll is always full-view: it supplies the mapping and the landmarks.
  const first = (await client.fetchLeague(season, league, FULL_VIEWS)) as DraftResponse;
  const myTeamId = Number(
    arg("team") ??
      first.teams?.find((t) => (t.owners ?? []).some((o) => o.toUpperCase() === swid.toUpperCase()))?.id ??
      NaN,
  );
  if (!Number.isFinite(myTeamId)) {
    console.error("could not identify your team in this league — pass --team <espnTeamId>");
    process.exit(2);
  }

  let mapping: Mapping = deriveMapping(first, myTeamId);
  const secrets = [espnS2, swid];

  const write = async (name: string, doc: unknown) => {
    const clean = sanitize(doc, mapping);
    assertClean(clean, mapping, secrets); // fail-closed: nothing unclean reaches disk
    await writeFile(join(outDir, name), JSON.stringify(clean, null, 2) + "\n");
    console.log(`  wrote ${name}`);
  };
  const record = async (doc: DraftResponse, at: string) => {
    const clean = sanitize({ captured_at: at, response: doc }, mapping);
    assertClean(clean, mapping, secrets);
    await appendFile(join(outDir, "observations.jsonl"), JSON.stringify(clean) + "\n");
  };

  console.log(`league ${league} season ${season}, my team ${myTeamId}, interval ${interval} ms`);
  console.log(`draft type: ${first.settings?.draftSettings?.type ?? "?"}, teams: ${first.teams?.length ?? 0}`);

  // Rounds come from the skeleton itself — do not assume 16.
  const total = (first.draftDetail?.picks ?? []).length;
  let sawOrder = false;
  let sawOpen = false;
  let midWritten = 0;
  let lastFilled = -1;
  let grewDuringDraft = false; // ← the Gate 0 verdict
  const started = Date.now();
  let sample = 0;

  // Which parts of the payload move at all during a live draft? If picks stay
  // frozen, this is what says whether some OTHER view carries live state.
  const sectionHashes = new Map<string, Set<string>>();
  const hash = (v: unknown) => {
    const s = JSON.stringify(v) ?? "";
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `${s.length}:${h}`;
  };
  const trackSections = (res: DraftResponse) => {
    const rostered = (res.teams ?? []).reduce(
      (n, t) => n + ((t as { roster?: { entries?: unknown[] } }).roster?.entries?.length ?? 0),
      0,
    );
    const sections: Record<string, unknown> = {
      "draftDetail.picks": res.draftDetail?.picks,
      "draftDetail.flags": [res.draftDetail?.inProgress, res.draftDetail?.drafted],
      "settings.draftSettings": res.settings?.draftSettings,
      teams: res.teams,
      "teams[].roster entry count": rostered,
    };
    for (const [k, v] of Object.entries(sections)) {
      if (!sectionHashes.has(k)) sectionHashes.set(k, new Set());
      sectionHashes.get(k)!.add(hash(v));
    }
    return rostered;
  };

  for (;;) {
    const full = sample === 0;
    const res = full
      ? first
      : ((await client.fetchLeague(season, league, FULL_VIEWS).catch((e) => {
          if (e instanceof EspnError) {
            console.error(`  poll error: ${e.code}${e.status ? ` (${e.status})` : ""}`);
            return null;
          }
          throw e;
        })) as DraftResponse | null);

    if (res) {
      const at = new Date().toISOString();
      const filled = filledPicks(res);
      const inProgress = res.draftDetail?.inProgress ?? false;
      const drafted = res.draftDetail?.drafted ?? false;

      await record(res, at);
      if (lastFilled >= 0 && filled > lastFilled && !drafted) grewDuringDraft = true;
      const rostered = trackSections(res);

      if (sample % 6 === 0 || filled !== lastFilled) {
        console.log(
          `  [${at}] picks=${filled}${total ? `/${total}` : ""} rostered=${rostered} inProgress=${inProgress} drafted=${drafted}`,
        );
      }

      if (!sawOrder && (res.settings?.draftSettings?.pickOrder?.length ?? 0) > 0) {
        sawOrder = true;
        await write("order.json", res);
      }
      if (!sawOpen && inProgress) {
        sawOpen = true;
        await write("open.json", await client.fetchLeague(season, league, FULL_VIEWS));
      }
      // Keep refreshing mid.json until roughly the midpoint.
      if (filled > 0 && !drafted && (total === 0 || midWritten < Math.ceil(total / 2))) {
        midWritten = filled;
        await write("mid.json", await client.fetchLeague(season, league, FULL_VIEWS));
      }
      if (drafted) {
        await write("complete.json", await client.fetchLeague(season, league, FULL_VIEWS));
        console.log("\ndraft complete.");
        break;
      }

      // Re-derive on full samples in case ESPN added a member mid-draft.
      if (full) mapping = mergeMapping(mapping, deriveMapping(res, myTeamId));
      lastFilled = filled;
    }

    sample++;
    if (flag("once")) break;
    if (Date.now() - started > maxMinutes * 60_000) {
      console.log(`\nstopping after ${maxMinutes} min.`);
      break;
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  // A single sample cannot show growth, and a completed draft cannot either —
  // reporting "mDraftDetail did NOT update" in those cases is a false alarm.
  // The verdict is only meaningful for a continuous run against a LIVE draft.
  const verdictApplies = sample >= 2 && !flag("once");
  console.log("\n=== GATE 0 SIGNAL (005 T003) ===");
  if (!verdictApplies) {
    console.log("not applicable: this was a single-shot capture, so growth between samples");
    console.log("cannot be observed. Run without --once against a LIVE draft for the verdict.");
  } else {
    console.log(`picks grew between samples while the draft was in progress: ${grewDuringDraft ? "YES" : "NO"}`);
    console.log(
      grewDuringDraft
        ? "mDraftDetail is live. The polling design holds — proceed with Phase 2."
        : "mDraftDetail did NOT update during the draft.",
    );
  }
  console.log("\nwhich sections changed at all during the run:");
  for (const [name, hashes] of sectionHashes) {
    console.log(`  ${hashes.size > 1 ? "CHANGED" : "static "}  ${name}  (${hashes.size} distinct)`);
  }
  if (verdictApplies && !grewDuringDraft) {
    const rosterMoved = (sectionHashes.get("teams[].roster entry count")?.size ?? 0) > 1;
    console.log(
      rosterMoved
        ? "\nBUT team rosters DID move — live picks are observable via mRoster. Re-plan the poll source, do not abandon polling."
        : "\nNo view moved. STOP: SC-001 is unachievable by polling; run /speckit-clarify (research §0).",
    );
  }
  console.log(`\nsamples: ${sample + 1} → ${join(outDir, "observations.jsonl")}`);
}

main().catch((e) => {
  // EspnError carries only a code; anything else is printed without its stack
  // to keep an accidental credential echo out of the terminal.
  console.error(e instanceof EspnError ? `ESPN error: ${e.code}` : `failed: ${(e as Error).message}`);
  process.exit(1);
});
