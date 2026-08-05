// 010 T047 — turn retained batches into a replayable fixture.
//
//   npx tsx scripts/export-tap-corpus.ts --league <espnLeagueId> --season 2026 \
//     [--out tests/fixtures/tap/replay-full.jsonl] [--local]
//
// Reads what the ingest kept, flattens it to one relay message per line in seq
// order, and verifies it is clean before writing. The retained payloads are
// already numeric-only — this re-checks rather than trusting.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const league = arg("league");
const season = arg("season", "2026")!;
const out = arg("out", "tests/fixtures/tap/replay-full.jsonl")!;
const remote = process.argv.includes("--local") ? [] : ["--remote"];

if (!league) {
  console.error("usage: npx tsx scripts/export-tap-corpus.ts --league <espnLeagueId> [--season 2026] [--out path] [--local]");
  process.exit(2);
}

const sql =
  `SELECT session_id, first_seq, messages_json FROM tap_batches ` +
  `WHERE espn_league_id = '${league.replace(/'/g, "")}' AND season = ${Number(season)} ` +
  `ORDER BY session_id, first_seq`;

const raw = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "draft-genie", ...remote, "--json", "--command", sql],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);

const match = /\[\s*\{[\s\S]*\}\s*\]/.exec(raw);
if (!match) throw new Error("could not parse wrangler output");
const rows = (JSON.parse(match[0]) as { results?: { session_id: string; messages_json: string }[] }[])[0]?.results ?? [];

const messages: unknown[] = [];
for (const r of rows) messages.push(...(JSON.parse(r.messages_json) as unknown[]));

const text = JSON.stringify(messages);
const GUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
if (GUID.test(text)) throw new Error("refusing to write: corpus contains an identifier");
if (/https?:\/\//.test(text)) throw new Error("refusing to write: corpus contains a URL");

writeFileSync(out, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

const kinds = messages.reduce<Record<string, number>>((acc, m) => {
  const k = String((m as { kind?: string }).kind ?? "?");
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
console.log(`wrote ${out}: ${rows.length} batches, ${messages.length} messages`, kinds);
