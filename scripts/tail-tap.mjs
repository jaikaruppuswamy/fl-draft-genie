// 010 — a readable live view of tap traffic.
//
// `wrangler tail --format json` emits PRETTY-PRINTED JSON objects, not
// line-delimited ones. A line-based parser silently matches the bare `{` and
// drops every event — which is how a whole live draft went unobserved while the
// relay was working fine. This decodes the stream properly.
//
//   node scripts/tail-tap.mjs [--all]

import { spawn } from "node:child_process";

const showAll = process.argv.includes("--all");
const wrangler = spawn("npx", ["wrangler", "tail", "draft-genie", "--format", "json"], {
  stdio: ["ignore", "pipe", "ignore"],
});

let buffer = "";
let depth = 0;
let start = -1;
let inString = false;
let escaped = false;
const totals = { requests: 0, accepted: 0, rejected: 0, messages: 0, kinds: {} };

function handle(event) {
  const url = event?.event?.request?.url ?? "";
  const isTap = url.includes("/api/tap/");
  if (!isTap && !showAll) return;
  totals.requests++;
  const path = url.split("draft.neelamjai.com")[1]?.split("?")[0] ?? url;
  const logs = (event.logs ?? []).map((l) => (l.message ?? []).join(" "));
  const exceptions = (event.exceptions ?? []).map((e) => e.message);
  const batch = logs.find((l) => l.startsWith("tap batch:"));
  if (batch) {
    totals.accepted++;
    const n = Number(/n=(\d+)/.exec(batch)?.[1] ?? 0);
    totals.messages += n;
    const kinds = /kinds=(\{.*\})/.exec(batch)?.[1];
    if (kinds) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(kinds))) totals.kinds[k] = (totals.kinds[k] ?? 0) + v;
      } catch { /* shape drift is not worth crashing over */ }
    }
  } else if (path.endsWith("/batch")) {
    totals.rejected++;
  }
  const when = new Date(event.eventTimestamp ?? Date.now()).toLocaleTimeString();
  const detail = batch ?? logs.join(" | ") ?? "";
  const flag = exceptions.length ? ` EXC(${exceptions.join(";")})` : "";
  const verdict = batch ? "ACCEPTED" : path.endsWith("/batch") ? "REJECTED-BEFORE-LOGGING" : "";
  console.log(`${when} ${path} ${verdict} ${detail}${flag}`.trim());
  if (totals.requests % 20 === 0) console.log(`--- ${JSON.stringify(totals)} ---`);
}

wrangler.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const text = buffer.slice(start, i + 1);
        try { handle(JSON.parse(text)); } catch { /* partial or non-event */ }
        buffer = buffer.slice(i + 1);
        i = -1;
        start = -1;
      }
    }
  }
});

const done = () => {
  console.log(`=== FINAL ${JSON.stringify(totals)} ===`);
  process.exit(0);
};
process.on("SIGINT", done);
process.on("SIGTERM", done);
wrangler.on("close", done);
