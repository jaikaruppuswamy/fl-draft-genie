// FR-004: tolerate common paste mistakes — surrounding whitespace/quotes,
// SWID without braces, lowercase SWID.

const SWID_CORE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function stripWrapping(value: string): string {
  let v = value.trim();
  while (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

export function normalizeEspnS2(raw: string): string | null {
  const v = stripWrapping(raw);
  // espn_s2 is a long opaque token; anything short is a paste mistake.
  if (v.length < 32 || /\s/.test(v)) return null;
  return v;
}

export function normalizeSwid(raw: string): string | null {
  let v = stripWrapping(raw);
  if (v.startsWith("{") && v.endsWith("}")) v = v.slice(1, -1);
  v = v.trim().toUpperCase();
  if (!SWID_CORE.test(v)) return null;
  return `{${v}}`;
}

/** The only displayable form of a SWID (FR-006). */
export function maskSwid(swid: string): string {
  const core = swid.replace(/[{}]/g, "");
  return `{${core.slice(0, 4)}…${core.slice(-4)}}`;
}
