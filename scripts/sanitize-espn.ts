// Sanitizer for captured ESPN responses (005 T001).
//
// ESPN's mSettings/mTeam payloads carry `members[].id` and `teams[].owners[]`,
// which ARE SWID GUIDs, plus real manager names and league/team names. The
// constitution classifies SWIDs as secrets and 001's fixture README forbids
// committing them, so nothing captured from a real league may reach the repo
// unsanitized.
//
// The mapping is DETERMINISTICALLY DERIVED and never persisted: recomputing it
// from the same league yields the same placeholders, so there is no lookup
// table of real GUIDs to leak. See tests/fixtures/espn/README.md.

/** SWID shape, with or without the braces ESPN usually includes. */
export const GUID_RE = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g;

/** The suite's "my" identity, already fixed by tests/fixtures/espn/README.md. */
export const MY_SWID = "{11111111-2222-3333-4444-555555555555}";

/** Below this length a real string is too collision-prone to replace globally:
 *  a manager's first name "Josh" must not corrupt "Josh Allen" in roster data,
 *  and a team abbrev "GB" must not corrupt NFL pro-team abbreviations. Short
 *  values are replaced by the targeted pass on their own fields instead. */
const GLOBAL_MIN_LEN = 6;

export interface Mapping {
  /** bare upper-case GUID -> placeholder (bare, no braces) */
  guid: Map<string, string>;
  /** distinctive real strings replaced ANYWHERE in the document */
  text: Map<string, string>;
  /** short/collision-prone values, replaced only on their own fields */
  fields: {
    members: Map<string, { displayName?: string; firstName?: string; lastName?: string }>;
    teams: Map<number, { name?: string; location?: string; nickname?: string; abbrev?: string }>;
  };
}

const bare = (g: string) => g.replace(/[{}]/g, "").toUpperCase();
const placeholderGuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface CaptureLike {
  settings?: { name?: string };
  members?: { id: string; displayName?: string; firstName?: string; lastName?: string }[];
  teams?: { id: number; name?: string; location?: string; nickname?: string; abbrev?: string; owners?: string[] }[];
}

/**
 * Derive the placeholder mapping from a league response.
 *
 * Teams sort by ESPN teamId ascending and take index n = 1..N. A member's index
 * is the lowest index among the teams they own; members owning no team follow
 * after. The owner of `myTeamId` always maps to MY_SWID.
 */
export function deriveMapping(res: CaptureLike, myTeamId?: number): Mapping {
  const guid = new Map<string, string>();
  const text = new Map<string, string>();
  const fields: Mapping["fields"] = { members: new Map(), teams: new Map() };
  /** Global only when distinctive enough not to collide with player/team data. */
  const global = (real: string | undefined, placeholder: string) => {
    if (real && real.length >= GLOBAL_MIN_LEN) text.set(real, placeholder);
  };

  const teams = [...(res.teams ?? [])].sort((a, b) => a.id - b.id);
  const indexByTeamId = new Map<number, number>();
  teams.forEach((t, i) => indexByTeamId.set(t.id, i + 1));

  // Lowest-team-index wins, so a multi-team owner is stable.
  const indexByMember = new Map<string, number>();
  for (const t of teams) {
    const n = indexByTeamId.get(t.id)!;
    for (const o of t.owners ?? []) {
      const k = bare(o);
      if (!indexByMember.has(k) || indexByMember.get(k)! > n) indexByMember.set(k, n);
    }
  }
  let next = teams.length + 1;
  for (const m of res.members ?? []) {
    const k = bare(m.id);
    if (!indexByMember.has(k)) indexByMember.set(k, next++);
  }

  const myOwners = new Set(
    (teams.find((t) => t.id === myTeamId)?.owners ?? []).map(bare),
  );

  for (const [k, n] of indexByMember) {
    guid.set(k, myOwners.has(k) ? bare(MY_SWID) : placeholderGuid(n));
  }

  for (const m of res.members ?? []) {
    const n = indexByMember.get(bare(m.id))!;
    fields.members.set(bare(m.id), {
      displayName: m.displayName ? `Manager ${n}` : undefined,
      firstName: m.firstName ? "Manager" : undefined,
      lastName: m.lastName ? String(n) : undefined,
    });
    global(m.displayName, `Manager ${n}`);
    // The full name is distinctive even when its parts are not.
    if (m.firstName && m.lastName) global(`${m.firstName} ${m.lastName}`, `Manager ${n}`);
  }

  for (const t of teams) {
    const n = indexByTeamId.get(t.id)!;
    fields.teams.set(t.id, {
      name: t.name ? `Team ${n}` : undefined,
      location: t.location ? "Team" : undefined,
      nickname: t.nickname ? String(n) : undefined,
      abbrev: t.abbrev ? `T${n}` : undefined,
    });
    global(t.name, `Team ${n}`);
    if (t.location && t.nickname) global(`${t.location} ${t.nickname}`, `Team ${n}`);
  }

  global(res.settings?.name, "Test League");

  return { guid, text, fields };
}

/** Merge mappings from several captures of the same league (later wins nothing). */
export function mergeMapping(a: Mapping, b: Mapping): Mapping {
  const guid = new Map(a.guid);
  const text = new Map(a.text);
  const fields: Mapping["fields"] = { members: new Map(a.fields.members), teams: new Map(a.fields.teams) };
  for (const [k, v] of b.guid) if (!guid.has(k)) guid.set(k, v);
  for (const [k, v] of b.text) if (!text.has(k)) text.set(k, v);
  for (const [k, v] of b.fields.members) if (!fields.members.has(k)) fields.members.set(k, v);
  for (const [k, v] of b.fields.teams) if (!fields.teams.has(k)) fields.teams.set(k, v);
  return { guid, text, fields };
}

function mapGuidString(s: string, m: Mapping, unknown: Map<string, string>): string {
  return s.replace(GUID_RE, (match) => {
    const hadBraces = match.startsWith("{");
    const k = bare(match);
    let repl = m.guid.get(k);
    if (!repl) {
      // A GUID we did not derive (an ESPN field we do not model). Still scrub it:
      // deterministic within a run, ordered by first appearance.
      repl = unknown.get(k) ?? placeholderGuid(900000000000 + unknown.size + 1);
      unknown.set(k, repl);
    }
    return hadBraces ? `{${repl}}` : repl;
  });
}

function mapText(s: string, m: Mapping): string {
  let out = s;
  // Longest first, so "Jai Karuppuswamy" is replaced before "Jai".
  for (const real of [...m.text.keys()].sort((a, b) => b.length - a.length)) {
    if (!real) continue;
    out = out.split(real).join(m.text.get(real)!);
  }
  return out;
}

/**
 * Deep-walk every string in the document. Field-by-field scrubbing would miss
 * the fields we do not model (ESPN ships plenty); walking everything and
 * matching on GUID shape plus known real strings is the property we want.
 */
export function sanitize<T>(value: T, m: Mapping, unknown = new Map<string, string>()): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return mapText(mapGuidString(v, m, unknown), m);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const out = walk(value) as T;

  // Second pass: overwrite the short, collision-prone identity fields on their
  // own objects. Keyed off the ORIGINAL document, because the walk has already
  // rewritten the GUIDs and team names the mapping is keyed by.
  const src = value as { members?: { id: string }[]; teams?: { id: number }[] };
  const dst = out as { members?: Record<string, unknown>[]; teams?: Record<string, unknown>[] };
  src.members?.forEach((member, i) => {
    const repl = m.fields.members.get(bare(member.id));
    const target = dst.members?.[i];
    if (!repl || !target) return;
    for (const k of ["displayName", "firstName", "lastName"] as const) {
      if (repl[k] !== undefined) target[k] = repl[k];
    }
  });
  src.teams?.forEach((team, i) => {
    const repl = m.fields.teams.get(team.id);
    const target = dst.teams?.[i];
    if (!repl || !target) return;
    for (const k of ["name", "location", "nickname", "abbrev"] as const) {
      if (repl[k] !== undefined) target[k] = repl[k];
    }
  });
  return out;
}

/**
 * Fail-closed check run before anything is written. `secrets` are values that
 * must never appear (the real cookie pair); `mapping` supplies the real names
 * and GUIDs that should all have been replaced.
 */
export function assertClean(doc: unknown, m: Mapping, secrets: string[] = []): void {
  const s = JSON.stringify(doc);
  const problems: string[] = [];

  for (const real of m.guid.keys()) {
    if (s.toUpperCase().includes(real)) problems.push(`real GUID survived sanitization`);
  }
  for (const real of m.text.keys()) {
    if (s.includes(real)) problems.push(`real string survived sanitization (${real.length} chars)`);
  }
  // Short identity fields are handled by the targeted pass, so assert on the
  // fields themselves rather than document-wide (a global check would fire on
  // legitimate collisions like an NFL player sharing a manager's first name).
  const shaped = doc as {
    members?: Record<string, unknown>[];
    teams?: Record<string, unknown>[];
  };
  const MEMBER_OK = /^(Manager( \d+)?|\d+)$/;
  const TEAM_OK = /^(Team( \d+)?|T\d+|\d+)$/;
  for (const member of shaped.members ?? []) {
    for (const k of ["displayName", "firstName", "lastName"] as const) {
      const v = member[k];
      if (typeof v === "string" && v && !MEMBER_OK.test(v)) problems.push(`members[].${k} not replaced`);
    }
  }
  for (const team of shaped.teams ?? []) {
    for (const k of ["name", "location", "nickname", "abbrev"] as const) {
      const v = team[k];
      if (typeof v === "string" && v && !TEAM_OK.test(v)) problems.push(`teams[].${k} not replaced`);
    }
  }
  for (const secret of secrets) {
    if (secret && s.includes(secret)) problems.push(`credential value present in output`);
  }
  const leftover = s.match(GUID_RE) ?? [];
  for (const g of leftover) {
    const b = bare(g);
    const allowed = b === bare(MY_SWID) || /^00000000-0000-4000-8000-\d{12}$/.test(b);
    if (!allowed) problems.push(`unmapped GUID in output`);
  }

  if (problems.length) {
    // Deliberately does not echo the offending value.
    throw new Error(`Sanitization check failed (${problems.length}): ${[...new Set(problems)].join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Tap-capture sanitization (010 T008)
//
// The draft-room realtime protocol carries SWIDs in places the league-response
// sanitizer above never sees. Established empirically from the Gate 0 capture:
//
//   SELECTED <team> <player> <round> [{member-SWID}]   ← 4th field, optional
//   JOINED   <team> {member-SWID}
//   TOKEN    <game>:<league>:<team>:{member-SWID}:<n>
//
// The `SELECTED` case is the one that matters: it means every human pick frame
// carries the drafting member's SWID. The INIT ledger, by contrast, was
// verified to contain ZERO strings and ZERO GUIDs (64% null bytes, fixed-width
// integer records), so its blob is committable as-is.
//
// Mapping derivation is the same rule as the league sanitizer: team index n
// (teams sorted ascending) -> {00000000-0000-4000-8000-0000000000NN}, and the
// capturing owner's own team -> MY_SWID. Deterministic, never persisted.

export interface TapFrame {
  seq?: number;
  at?: string;
  transport?: string;
  event?: string;
  url?: string;
  enc?: string;
  data?: string;
}

const bareGuid = (g: string) => g.replace(/[{}]/g, "").toUpperCase();

/**
 * Derive the GUID mapping from a tap capture. `JOINED` frames give team->SWID;
 * the `TOKEN` frame identifies the capturing owner, whose SWID maps to MY_SWID.
 */
export function deriveTapMapping(frames: TapFrame[], leagueIdPlaceholder = "1111111"): Mapping {
  const teamBySwid = new Map<string, number>();
  let ownerSwid: string | null = null;
  let realLeagueId: string | null = null;

  for (const f of frames) {
    const d = f.data;
    if (typeof d !== "string") continue;
    const joined = /^JOINED\s+(\d+)\s+(\{[^}]+\})/.exec(d);
    if (joined) teamBySwid.set(bareGuid(joined[2]!), Number(joined[1]));
    const token = /^TOKEN\s+\d+:(\d+):\d+:(\{[^}]+\})/.exec(d);
    if (token) {
      realLeagueId = token[1]!;
      ownerSwid = bareGuid(token[2]!);
    }
  }

  const guid = new Map<string, string>();
  for (const [swid, team] of [...teamBySwid].sort((a, b) => a[1] - b[1])) {
    guid.set(
      swid,
      swid === ownerSwid ? bareGuid(MY_SWID) : `00000000-0000-4000-8000-${String(team).padStart(12, "0")}`,
    );
  }
  if (ownerSwid && !guid.has(ownerSwid)) guid.set(ownerSwid, bareGuid(MY_SWID));

  const text = new Map<string, string>();
  if (realLeagueId) text.set(realLeagueId, leagueIdPlaceholder);

  return { guid, text, fields: { members: new Map(), teams: new Map() } };
}

// --- Embedded member identities -------------------------------------------
//
// A tap capture is not only draft-room frames. `capture.user.js` also records
// XHR `loadend` bodies, and the draftInit response embeds the league's
// `members[]` array — real first names, last names and ESPN handles — as an
// ESCAPED JSON STRING inside `data`. The GUID pass never saw them, because
// they are not GUIDs, and `assertTapClean` only checked GUIDs and the league
// id. Result: two fixtures shipped to a public repo with real names in them.
//
// Two properties this pass MUST have, both learned the hard way:
//
//  1. STRUCTURAL, not textual. The `m.text` map does a blind split/join, and
//     these are short common words — one member's firstName is literally
//     "event" and another's lastName is "regs". A global replace would rewrite
//     JSON keys and corrupt the fixture.
//  2. SCOPED to `members[]`. The same response carries `players[].firstName`
//     ("Jaheim", "Marcedes") — real NFL players, public data the decode tests
//     depend on. Scrubbing every `firstName` would destroy the fixture's value.

const MEMBER_NAME_FIELDS = ["displayName", "firstName", "lastName"] as const;
const DERIVED_GUID = /^0{8}-0000-4000-8000-(\d{12})$/;

/** Stable, meaningful label for a member: prefer the team number already
 *  encoded in its (possibly sanitized) GUID, else position of appearance. */
function memberOrdinal(id: unknown, index: number): number {
  if (typeof id === "string") {
    const m = DERIVED_GUID.exec(bareGuid(id).toLowerCase());
    if (m) return Number(m[1]);
  }
  return index + 1;
}

/**
 * Walk a parsed JSON value, rewriting every `members[]` entry's name fields.
 * Recurses into strings that themselves hold JSON, which is exactly how the
 * captured XHR bodies nest. Returns the value (mutated in place).
 */
function scrubMembersDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubMembersDeep(value[i]);
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const members = obj.members;
    if (Array.isArray(members)) {
      members.forEach((member, i) => {
        if (!member || typeof member !== "object") return;
        const rec = member as Record<string, unknown>;
        const n = memberOrdinal(rec.id, i);
        for (const k of MEMBER_NAME_FIELDS) {
          if (typeof rec[k] !== "string" || !rec[k]) continue;
          rec[k] = k === "displayName" ? `Manager ${n}` : k === "firstName" ? "Manager" : String(n);
        }
      });
    }
    for (const k of Object.keys(obj)) {
      if (k === "members") continue; // already handled above
      obj[k] = scrubMembersDeep(obj[k]);
    }
    return obj;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      return value; // a truncated body — handled by the textual fallback below
    }
    if (!parsed || typeof parsed !== "object") return value;
    return JSON.stringify(scrubMembersDeep(parsed));
  }
  return value;
}

/**
 * Textual fallback for member blocks inside a body that does NOT parse.
 *
 * Captured XHR bodies are TRUNCATED mid-response (the recorder caps them), so
 * `JSON.parse` fails on exactly the frames that carry `members[]`. Matching the
 * member object shape — a `members` key followed by objects containing an
 * `isLeagueCreator`/`isLeagueManager` flag — keeps this scoped to managers and
 * away from `players[]`, which has no such field.
 */
/**
 * Spans of the member objects inside every `"members":[...]` array in `s`.
 *
 * Brace-depth walking, NOT a regex. `/\{[^{}]*\}/` cannot match a member object
 * because the `id` value is itself brace-wrapped (`"{00000000-…}"`), so the
 * naive pattern skipped every real member and the scrubber reported success
 * while changing nothing. That false CLEAN is exactly how this shipped.
 */
function memberObjectSpans(s: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const membersKey = /\\?"members\\?"\s*:\s*\[/g;
  for (let km = membersKey.exec(s); km; km = membersKey.exec(s)) {
    let i = km.index + km[0].length;
    let depth = 1;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === "{") {
        const objStart = i;
        let d = 0;
        for (; i < s.length; i++) {
          if (s[i] === "{") d++;
          else if (s[i] === "}" && --d === 0) {
            i++;
            break;
          }
        }
        spans.push({ start: objStart, end: i });
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]") depth--;
      i++;
    }
  }
  return spans;
}

function scrubMemberBlockText(s: string): string {
  const spans = memberObjectSpans(s);
  let out = "";
  let cursor = 0;
  spans.forEach((span, n) => {
    const objText = s.slice(span.start, span.end);
    const idMatch = /\\?"id\\?"\s*:\s*\\?"\{?([0-9A-Fa-f-]{36})\}?/.exec(objText);
    const ord = memberOrdinal(idMatch?.[1], n);
    out +=
      s.slice(cursor, span.start) +
      objText
        .replace(/(\\?"displayName\\?"\s*:\s*\\?")([^"\\]*)/g, `$1Manager ${ord}`)
        .replace(/(\\?"firstName\\?"\s*:\s*\\?")([^"\\]*)/g, `$1Manager`)
        .replace(/(\\?"lastName\\?"\s*:\s*\\?")([^"\\]*)/g, `$1${ord}`);
    cursor = span.end;
  });
  return out + s.slice(cursor);
}

/** Scrub member identities from a captured body, parsed or truncated. */
export function scrubMemberIdentities(s: string): string {
  const structural = scrubMembersDeep(s);
  return scrubMemberBlockText(typeof structural === "string" ? structural : String(structural));
}

/**
 * Every member-identity name in an arbitrary blob, at any nesting depth and
 * through JSON-in-string encoding. Shared by `assertTapClean` and the privacy
 * sweep so the two cannot disagree about what counts as a leak.
 *
 * Scoped to objects carrying `isLeagueCreator`/`isLeagueManager` — the marker
 * that distinguishes a league member from an NFL player, both of which have
 * `firstName`/`lastName`.
 */
export function memberNamesIn(blob: string): string[] {
  const found: string[] = [];
  for (const span of memberObjectSpans(blob)) {
    const objText = blob.slice(span.start, span.end);
    for (const k of MEMBER_NAME_FIELDS) {
      const re = new RegExp(`\\\\?"${k}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]*)`, "g");
      for (let m = re.exec(objText); m; m = re.exec(objText)) {
        if (m[1]) found.push(m[1]);
      }
    }
  }
  return found;
}

/** Sanitize one captured frame. Unknown GUIDs are still scrubbed, never passed. */
export function sanitizeTapFrame(frame: TapFrame, m: Mapping, unknown = new Map<string, string>()): TapFrame {
  const scrub = (s: string) => {
    let out = s.replace(GUID_RE, (match) => {
      const hadBraces = match.startsWith("{");
      const k = bareGuid(match);
      let repl = m.guid.get(k);
      if (!repl) {
        repl = unknown.get(k) ?? `00000000-0000-4000-8000-${String(900000000000 + unknown.size + 1)}`;
        unknown.set(k, repl);
      }
      return hadBraces ? `{${repl}}` : repl;
    });
    // Literal replacement, NOT a \b-anchored regex: the league id also appears
    // percent-encoded inside nested URLs (`%3D<leagueId>%26`), where the `D`
    // from `%3D` destroys the left word boundary and a \b rule silently misses
    // it. Caught by assertTapClean the first time this ran.
    for (const [real, placeholder] of m.text) out = out.split(real).join(placeholder);
    return out;
  };

  const out: TapFrame = { ...frame };
  if (typeof out.data === "string" && out.enc !== "b64") out.data = scrub(scrubMemberIdentities(out.data));
  if (typeof out.url === "string") out.url = scrub(out.url);
  return out;
}

/** Fail-closed check for a sanitized tap capture, run before it is committed. */
export function assertTapClean(frames: TapFrame[], m: Mapping): void {
  const problems: string[] = [];
  const blob = JSON.stringify(frames);
  for (const real of m.guid.keys()) {
    if (blob.toUpperCase().includes(real)) problems.push("real SWID survived sanitization");
  }
  for (const real of m.text.keys()) {
    if (blob.includes(real)) problems.push("real league id survived sanitization");
  }
  const ALLOWED = /^(00000000-0000-4000-8000-\d{12}|11111111-2222-3333-4444-555555555555)$/;
  for (const g of blob.match(GUID_RE) ?? []) {
    if (!ALLOWED.test(bareGuid(g).toLowerCase()) && !ALLOWED.test(bareGuid(g))) {
      problems.push("unmapped GUID in output");
    }
  }
  // Member identities. This is the check whose absence let real names ship:
  // the GUID and league-id passes above both reported clean while `members[]`
  // sat in an XHR body carrying full names. Assert on the member fields
  // themselves — scoped, so `players[].firstName` (real NFL players, which the
  // fixtures legitimately need) does not trip it.
  for (const name of memberNamesIn(blob)) {
    if (!/^(Manager( \d+)?|\d+)$/.test(name)) problems.push(`member name survived sanitization: ${name.length} chars`);
  }
  if (problems.length) throw new Error(`Tap sanitization failed: ${[...new Set(problems)].join("; ")}`);
}
