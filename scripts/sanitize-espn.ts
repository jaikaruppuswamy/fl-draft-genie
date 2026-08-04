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
