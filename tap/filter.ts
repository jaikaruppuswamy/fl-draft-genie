// 010 T018 — the privacy allowlist (FR-006a/b/c).
//
// The US1 capture established that SELECTED carries a member SWID in an
// optional FOURTH field, so every human pick frame is a potential leak. Prior
// research had concluded SWIDs lived only in CHAT/JOINED/LEFT/ACL; they do not.
//
// This operates on DECODED content, never the wire form (FR-006c): relaying an
// encoded blob would satisfy the letter of FR-005 while carrying exactly the
// identities this forbids, and would pass an inspection that cannot see inside.

import type { LedgerPick } from "./decode";

export interface PickPayload {
  teamId: number;
  playerId: number;
  /** Unresolved protocol field, carried opaque and never interpreted. */
  slot3: number;
  /** Only present from the ledger; SELECTED carries no ordinal. */
  overallPickNumber?: number;
}

/** SELECTED <teamId> <playerId> <field3> [{memberSWID}] — field 4 is DROPPED. */
export function filterPickFields(fields: string[]): PickPayload | null {
  if (fields.length < 3) return null;
  const [team, player, third] = fields;
  const teamId = Number(team);
  const playerId = Number(player);
  const slot3 = Number(third);
  // Negative player ids are legitimate (D/ST near -16000). Never filter on sign.
  if (!Number.isInteger(teamId) || !Number.isInteger(playerId) || !Number.isInteger(slot3)) return null;
  return { teamId, playerId, slot3 };
}

export function filterLedgerPick(p: LedgerPick): PickPayload {
  return {
    teamId: p.teamId,
    playerId: p.playerId,
    slot3: p.slot3,
    overallPickNumber: p.overallPickNumber,
  };
}

const GUID = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/;

/**
 * Fail-closed check applied to anything about to be transmitted. The allowlist
 * above is the control; this is the assertion that it worked, so a future edge
 * case surfaces as a thrown error rather than a silent leak.
 */
export function assertTransmittable(value: unknown): void {
  const json = JSON.stringify(value ?? null);
  if (GUID.test(json)) throw new Error("refusing to transmit: value contains a GUID");
  // Any string at all is suspicious in a numeric-only payload; the only strings
  // we send are our own enum-ish metadata, checked by the caller's shape.
  const strings = json.match(/"[^"]*"/g) ?? [];
  for (const s of strings) {
    if (/https?:\/\//.test(s)) throw new Error("refusing to transmit: value contains a URL");
  }
}
