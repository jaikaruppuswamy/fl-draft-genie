// One-shot read-only probe (005 Gate 0 follow-up).
//
// Gate 0 established that `draftDetail.picks` stays frozen at playerId -1
// during a live snake draft. This asks the follow-up that decides whether the
// feature needs a new transport or merely a different poll source: with picks
// already made, does ANY view expose them?
//
//   ESPN_S2='...' SWID='{...}' npx tsx scripts/probe-draft.ts --league <id> [--season 2026]
//
// Prints a summary only — no fixtures written, no cookies printed.

import { createEspnClient, type EspnView } from "../src/espn/client";
import type { Env } from "../src/env";
import { EspnError } from "../src/espn/types";

const VIEWS: EspnView[][] = [
  ["mDraftDetail"],
  ["mRoster"],
  ["mTeam"],
  ["mSettings", "mTeam", "mDraftDetail", "mRoster"],
];

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Count every plausible player reference, wherever it hides. */
function scan(doc: unknown) {
  let filledPicks = 0;
  let skeletonPicks = 0;
  let rosterEntries = 0;
  const playerIds = new Set<number>();

  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, path));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if ("overallPickNumber" in o && "playerId" in o) {
      const id = Number(o.playerId);
      if (id > 0) {
        filledPicks++;
        playerIds.add(id);
      } else skeletonPicks++;
    }
    if ("playerPoolEntry" in o || ("playerId" in o && "lineupSlotId" in o && !("overallPickNumber" in o))) {
      rosterEntries++;
      const id = Number(o.playerId ?? (o.playerPoolEntry as { id?: number } | undefined)?.id);
      if (id > 0) playerIds.add(id);
    }
    for (const [k, val] of Object.entries(o)) walk(val, `${path}.${k}`);
  };
  walk(doc, "$");
  return { filledPicks, skeletonPicks, rosterEntries, distinctPlayers: playerIds.size };
}

async function main() {
  const league = arg("league");
  const season = Number(arg("season", String(new Date().getFullYear())));
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.SWID;
  if (!league || !espnS2 || !swid) {
    console.error("usage: ESPN_S2='...' SWID='{...}' npx tsx scripts/probe-draft.ts --league <id> [--season <y>]");
    process.exit(2);
  }

  const client = createEspnClient({} as Env, { espnS2, swid });
  console.log(`probing league ${league} (${season}) — where are the picks that were already made?\n`);

  for (const views of VIEWS) {
    try {
      const res = (await client.fetchLeague(season, league, views)) as Record<string, unknown>;
      const s = scan(res);
      const dd = res.draftDetail as { inProgress?: boolean; drafted?: boolean } | undefined;
      console.log(
        `view=${views.join("+").padEnd(38)} filledPicks=${String(s.filledPicks).padStart(3)}  ` +
          `skeleton=${String(s.skeletonPicks).padStart(3)}  rosterEntries=${String(s.rosterEntries).padStart(3)}  ` +
          `distinctPlayers=${String(s.distinctPlayers).padStart(3)}  inProgress=${dd?.inProgress}  drafted=${dd?.drafted}`,
      );
    } catch (e) {
      console.log(`view=${views.join("+").padEnd(38)} ERROR ${e instanceof EspnError ? e.code : (e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 2500)); // stay polite (FR-008)
  }

  console.log(
    "\nReading it: filledPicks>0 anywhere ⇒ that view is a candidate live source.\n" +
      "rosterEntries>0 with filledPicks=0 ⇒ picks land on rosters but not in draftDetail.\n" +
      "all zero ⇒ ESPN exposes an in-progress draft nowhere in the v3 read API.",
  );
}

main().catch((e) => {
  console.error(e instanceof EspnError ? `ESPN error: ${e.code}` : `failed: ${(e as Error).message}`);
  process.exit(1);
});
