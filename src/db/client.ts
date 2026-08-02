// Thin typed helpers over D1. Every account-owned query is scoped by account id
// at the call site (FR-003); helpers never widen a query beyond what's passed in.

export function uuid(): string {
  return crypto.randomUUID();
}

export function iso(d: Date): string {
  return d.toISOString();
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
