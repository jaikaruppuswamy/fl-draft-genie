// 010 T011 — bundle the userscript.
//
// esbuild bundles tap/main.ts to a single IIFE and prepends the metadata block.
// The banner is plain text esbuild will not touch, so the @version there and the
// TAP_VERSION constant inlined into the code can silently diverge — and the tap
// would then report a version it is not (FR-022). The assertion below is what
// stops that.

import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "web/public/draft-tap.user.js");

// Read the metadata straight from the module that owns it, rather than
// duplicating it here — one source, per T010.
const metaSrc = await readFile(join(root, "tap/meta.ts"), "utf8");
const version = /export const TAP_VERSION = "([^"]+)"/.exec(metaSrc)?.[1];
const banner = /export const META_BLOCK = `([\s\S]*?)`;/.exec(metaSrc)?.[1];

if (!version) throw new Error("build-tap: could not read TAP_VERSION from tap/meta.ts");
if (!banner) throw new Error("build-tap: could not read META_BLOCK from tap/meta.ts");

// Resolve the template literal's ${TAP_VERSION} / ${INGEST_ORIGIN} references.
const ingest = /export const INGEST_ORIGIN = "([^"]+)"/.exec(metaSrc)?.[1] ?? "";
const resolvedBanner = banner
  .replaceAll("${TAP_VERSION}", version)
  .replaceAll("${INGEST_ORIGIN}", ingest);

const bannerVersion = /^\/\/ @version\s+(\S+)$/m.exec(resolvedBanner)?.[1];
if (bannerVersion !== version) {
  throw new Error(
    `build-tap: metadata @version (${bannerVersion}) !== TAP_VERSION (${version}). ` +
      `The tap would report a version it is not — see FR-022.`,
  );
}

await mkdir(dirname(OUT), { recursive: true });

const result = await build({
  entryPoints: [join(root, "tap/main.ts")],
  bundle: true,
  format: "iife",
  target: "chrome120",
  platform: "browser",
  banner: { js: resolvedBanner },
  // No minification: this ships to a script manager where the user can and
  // should be able to read what runs in their draft room.
  minify: false,
  legalComments: "inline",
  outfile: OUT,
  write: false,
});

const out = result.outputFiles[0].text;

// The bundle must never reach ESPN. A literal check is cheap insurance against
// a future edit introducing one (Constitution VI, FR-001).
const ESPN_REQUEST_PATTERNS = [
  /fetch\s*\(\s*["'`]https?:\/\/[^"'`]*espn\.com/i,
  /GM_xmlhttpRequest\s*\(\s*\{[^}]*url\s*:\s*["'`]https?:\/\/[^"'`]*espn\.com/i,
  /new\s+(?:WebSocket|EventSource)\s*\(\s*["'`]/i,
];
for (const pattern of ESPN_REQUEST_PATTERNS) {
  if (pattern.test(out)) {
    throw new Error(
      `build-tap: bundle appears to originate a request to ESPN (matched ${pattern}) — ` +
        `passivity violation, see Constitution VI / FR-001`,
    );
  }
}

await writeFile(OUT, out);
console.log(`built ${OUT}  (v${version}, ${(out.length / 1024).toFixed(1)} kB)`);
