// 010 T020 — what kind of message is this?
//
// FR-017a exists because ESPN's own parser has NO `default:` branch: it silently
// drops verbs it does not know. Ours must deliberately differ, or a protocol
// change looks identical to a quiet draft.
//
// The distinction is: a message matching a KNOWN non-draft kind is dropped
// silently; anything UNRECOGNISED is counted and reported.

import { DRAFT_HOST, IGNORED_HOSTS } from "./meta";

export type Classification =
  | { kind: "pick"; verb: "SELECTED"; fields: string[] }
  | { kind: "ledger"; verb: "INIT"; payload: string }
  | { kind: "known-non-draft"; verb: string }
  | { kind: "unrecognised"; verb: string };

/** Verbs observed in the US1 capture that are real but carry no pick data.
 *  PONG is the INBOUND keep-alive; PING is client→server only and we never
 *  send anything. */
export const KNOWN_NON_DRAFT = new Set([
  "PONG", "CLOCK", "SELECTING", "AUTOSUGGEST", "AUTODRAFT",
  "JOINED", "LEFT", "TOKEN", "STATE", "CHAT", "ACL",
]);

/** Is this socket the draft room, or ESPN's unrelated second socket?
 *  The capture showed four sockets to bamgrid on the same page; relaying those
 *  would breach FR-006 and flood the unrecognised counter with ESPN's own JSON. */
export function isDraftChannel(url: string): boolean {
  let host: string;
  try {
    host = new URL(url, "https://fantasy.espn.com").hostname;
  } catch {
    return false;
  }
  if (IGNORED_HOSTS.includes(host)) return false;
  return host === DRAFT_HOST;
}

/** WS frames arrive with a trailing newline, SSE frames without. Normalise. */
export const normalise = (raw: string) => raw.replace(/\n$/, "");

export function classify(raw: string): Classification {
  const text = normalise(raw);
  const verb = text.split(" ", 1)[0] ?? "";

  if (verb === "SELECTED") {
    return { kind: "pick", verb, fields: text.split(" ").slice(1) };
  }
  if (verb === "INIT") {
    return { kind: "ledger", verb, payload: text.slice(5).trim() };
  }
  if (KNOWN_NON_DRAFT.has(verb)) return { kind: "known-non-draft", verb };
  return { kind: "unrecognised", verb: verb.slice(0, 32) };
}
