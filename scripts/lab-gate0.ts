// 008 T001 — GATE 0. The one unverified premise, tested before dependent code.
//
//   ESPN_S2='...' SWID='{...}' npx tsx scripts/lab-gate0.ts --league <id> --season 2024
//
// THE QUESTION: does ESPN still serve a completed draft for a PAST season?
//
// 005's Gate 0 proved ESPN writes the completed draft reliably — but it proved
// that for the CURRENT season, on a draft that had just finished. Nothing has
// ever asked a two-year-old league. 008's spec assumed the answer was yes and
// built a whole use class on it (`pick_sequence_only`), which is exactly the
// shape of assumption 005 paid eight phases for.
//
// TWO URL FORMS, DELIBERATELY. `src/espn/client.ts` addresses
// `/seasons/{season}/segments/0/leagues/{id}`, which is correct for the current
// season. ESPN serves prior seasons from `/leagueHistory/{id}?seasonId={year}`,
// which returns an ARRAY rather than an object. Probing only the client's form
// would let "ESPN has no past drafts" and "we asked the wrong way" produce the
// same answer, and those have opposite consequences for this feature.
//
// PRINTS A SUMMARY ONLY. No fixture is written, no response is dumped, and the
// cookies never appear in a URL, a log line or an error (constitution: ESPN
// credentials are secrets).

import { EspnError } from "../src/espn/types";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Probe {
  form: string;
  ok: boolean;
  status: number | string;
  filledPicks: number;
  skeletonPicks: number;
  distinctPlayers: number;
  keepers: number;
  hasOrder: boolean;
  note?: string;
}

/**
 * Count pick-shaped objects wherever they hide.
 *
 * NEVER filters on the sign of `playerId`: `-1` is the empty-slot sentinel and
 * D/ST ids are legitimately near −16000. `playerId > 0` is what made 010's
 * capture report 66 of 72 picks for a complete draft, so the two are counted
 * separately rather than one being discarded.
 */
function scan(doc: unknown): Omit<Probe, "form" | "ok" | "status" | "note"> {
  let filledPicks = 0;
  let skeletonPicks = 0;
  let keepers = 0;
  let hasOrder = false;
  const players = new Set<number>();

  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if ("overallPickNumber" in o && "playerId" in o) {
      const id = Number(o.playerId);
      if (id === -1) skeletonPicks++;
      else {
        filledPicks++;
        players.add(id);
      }
      if (o.keeper === true) keepers++;
    }
    if ("draftOrder" in o || "pickOrder" in o) hasOrder = true;
    for (const val of Object.values(o)) walk(val);
  };
  walk(doc);
  return { filledPicks, skeletonPicks, distinctPlayers: players.size, keepers, hasOrder };
}

async function probe(url: string, form: string, cookie: string): Promise<Probe> {
  const empty = { filledPicks: 0, skeletonPicks: 0, distinctPlayers: 0, keepers: 0, hasOrder: false };
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { Accept: "application/json", Cookie: cookie } });
  } catch {
    // The URL is deliberately absent from the message: it carries the league id
    // and, in a mistyped invocation, could carry more.
    return { form, ok: false, status: "unreachable", ...empty };
  }
  if (!res.ok) return { form, ok: false, status: res.status, ...empty };

  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    return { form, ok: false, status: "unparseable", ...empty };
  }
  // leagueHistory returns an ARRAY of season documents; the seasons endpoint
  // returns one object. Scanning handles both, but say which came back.
  const shape = Array.isArray(doc) ? `array[${doc.length}]` : "object";
  return { form, ok: true, status: res.status, ...scan(doc), note: shape };
}

async function main(): Promise<void> {
  const league = arg("league");
  const season = Number(arg("season", "2024"));
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.SWID;

  if (!league || !espnS2 || !swid) {
    console.error(
      "usage: ESPN_S2='...' SWID='{...}' npx tsx scripts/lab-gate0.ts --league <espnLeagueId> [--season 2024]",
    );
    process.exit(2);
  }

  const cookie = `espn_s2=${espnS2}; SWID=${swid}`;
  const results = [
    await probe(
      `${BASE}/seasons/${season}/segments/0/leagues/${encodeURIComponent(league)}?view=mDraftDetail&view=mSettings`,
      "seasons (the client's current form)",
      cookie,
    ),
    await probe(
      `${BASE}/leagueHistory/${encodeURIComponent(league)}?seasonId=${season}&view=mDraftDetail&view=mSettings`,
      "leagueHistory (ESPN's documented past-season form)",
      cookie,
    ),
  ];

  console.log(`\nGATE 0 — league ${league}, season ${season}\n`);
  for (const r of results) {
    console.log(`  ${r.form}`);
    console.log(`    status ............ ${r.status}${r.note ? ` (${r.note})` : ""}`);
    console.log(`    filled picks ...... ${r.filledPicks}`);
    console.log(`    skeleton picks .... ${r.skeletonPicks}   (playerId === -1)`);
    console.log(`    distinct players .. ${r.distinctPlayers}`);
    console.log(`    keepers ........... ${r.keepers}`);
    console.log(`    draft order ....... ${r.hasOrder ? "present" : "absent"}\n`);
  }

  const usable = results.filter((r) => r.ok && r.filledPicks > 0);
  if (usable.length > 0) {
    console.log(`VERDICT: PASS — past-season drafts are readable via: ${usable.map((r) => r.form).join(", ")}`);
    console.log("  US3's pick-sequence-only half has a source. Phase 5 proceeds as planned.");
    if (!usable.some((r) => r.form.startsWith("seasons"))) {
      console.log(
        "  NOTE: only leagueHistory worked, so `src/espn/client.ts` needs a second URL form for imports.",
      );
    }
  } else {
    console.log("VERDICT: FAIL — no past-season picks came back.");
    console.log("  Consequences to record in research.md §12 before building Phase 5:");
    console.log("    * `pick_sequence_only` has no source; the class stays defined but empty.");
    console.log("    * T052 has no data, so T055's `noiseSd` is an assumption and must say so.");
    console.log("    * US3 reduces to CURRENT-season import — still valuable: it reaches");
    console.log("      leagues the tap never ran on, and those are fully replayable.");
  }
  console.log("");
}

main().catch((e) => {
  // EspnError is imported so a credential rejection reads clearly rather than
  // as a bare status code; the error never carries the cookie.
  console.error(e instanceof EspnError ? `ESPN rejected the read: ${e.message}` : String(e));
  process.exit(1);
});
