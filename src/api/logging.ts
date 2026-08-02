// Secret-redacting logging wrapper (FR-006 / SC-005). All server logging goes
// through here; defensively strips anything shaped like an espn_s2 value or a
// full SWID GUID even if a call site slips one into a message.

const SWID_PATTERN = /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/g;
// espn_s2 values are long URL-safe-ish blobs, often containing % escapes.
const S2_ASSIGN_PATTERN = /(espn_s2\s*[=:]\s*)[^\s;,"']+/gi;
const LONG_OPAQUE_PATTERN = /[A-Za-z0-9%+/]{80,}/g;

export function redact(message: string): string {
  return message
    .replace(S2_ASSIGN_PATTERN, "$1[redacted]")
    .replace(SWID_PATTERN, "{[redacted]}")
    .replace(LONG_OPAQUE_PATTERN, "[redacted]");
}

export function logInfo(message: string): void {
  console.log(redact(message));
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? ` ${err.name}: ${err.message}` : "";
  console.error(redact(`${message}${detail}`));
}
