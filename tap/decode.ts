// 010 T016 — the ledger reader.
//
// OUR OWN reader, deliberately not a port of ESPN's: their readDouble/readFloat
// discard the bytes and return Math.random(), so a port inherits garbage for
// every non-integer field (research §2). We only read integers, and we assert
// rather than assume.
//
// Layout established from the US1 capture and cross-checked against the
// independent oracle (see contracts/ingest.md):
//
//   72 fixed-width records, stride 45 bytes, in one pre-allocated array
//     +0  int32  teamId
//     +4  int32  overallPickNumber   (1-based, dense)
//     +8  int32  playerId            (-1 = empty slot; NEGATIVE ids are D/ST)
//     +12 int32  slot3               (same value as SELECTED's field 3 — 27/27;
//                                      meaning UNRESOLVED, carried opaque)
//
// The array's byte offset is NOT hardcoded. It was 2078 in the captured draft,
// but that prefix holds league settings whose size varies by league shape. We
// locate the array by its invariant instead — a run of records whose
// overallPickNumber is exactly 1,2,3,… — which both generalises and fails
// loudly if ESPN changes the layout (FR-017), rather than silently misreading.

export const RECORD_STRIDE = 45;
const OFF_TEAM = 0;
const OFF_OVERALL = 4;
const OFF_PLAYER = 8;
const OFF_SLOT3 = 12;

/** ESPN's empty-slot sentinel. Do NOT treat "negative" as empty — D/ST player
 *  ids are legitimately around -16000. */
export const EMPTY_PLAYER_ID = -1;

export interface LedgerPick {
  teamId: number;
  overallPickNumber: number;
  playerId: number;
  /** Unresolved protocol field, carried opaque. Never interpreted. */
  slot3: number;
}

export interface Ledger {
  /** Every slot, in order, including unfilled ones. */
  slots: (LedgerPick | null)[];
  /** Byte offset the record array was found at — diagnostic only. */
  arrayOffset: number;
  totalSlots: number;
}

export class LedgerFormatError extends Error {
  constructor(message: string) {
    super(`ledger format: ${message}`);
    this.name = "LedgerFormatError";
  }
}

function readI32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw new LedgerFormatError(`read past end at ${offset} (length ${view.byteLength})`);
  }
  return view.getInt32(offset, false); // big-endian, as observed
}

/** Decode `INIT <base64>` payload bytes into the pick array. */
export function decodeLedger(bytes: Uint8Array, opts: { minSlots?: number } = {}): Ledger {
  const minSlots = opts.minSlots ?? 12;
  if (bytes.byteLength < RECORD_STRIDE * minSlots) {
    throw new LedgerFormatError(`too short: ${bytes.byteLength} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate the array by invariant: consecutive records whose overallPickNumber
  // counts 1,2,3,… A false positive would need that exact pattern at a 45-byte
  // stride, which the surrounding settings data does not produce.
  let best = { offset: -1, count: 0 };
  for (let start = 0; start + RECORD_STRIDE * minSlots <= bytes.byteLength; start++) {
    if (readI32(view, start + OFF_OVERALL) !== 1) continue;
    let count = 1;
    for (;;) {
      const next = start + count * RECORD_STRIDE;
      if (next + RECORD_STRIDE > bytes.byteLength) break;
      if (readI32(view, next + OFF_OVERALL) !== count + 1) break;
      count++;
    }
    if (count > best.count) best = { offset: start, count };
  }

  if (best.count < minSlots) {
    throw new LedgerFormatError(
      `no pick array found (longest run ${best.count} < ${minSlots}) — ESPN's ledger layout may have changed`,
    );
  }

  const slots: (LedgerPick | null)[] = [];
  for (let n = 0; n < best.count; n++) {
    const at = best.offset + n * RECORD_STRIDE;
    const playerId = readI32(view, at + OFF_PLAYER);
    slots.push(
      playerId === EMPTY_PLAYER_ID
        ? null
        : {
            teamId: readI32(view, at + OFF_TEAM),
            overallPickNumber: readI32(view, at + OFF_OVERALL),
            playerId,
            slot3: readI32(view, at + OFF_SLOT3),
          },
    );
  }

  return { slots, arrayOffset: best.offset, totalSlots: best.count };
}

/** The picks actually made, in draft order. */
export function filledPicks(ledger: Ledger): LedgerPick[] {
  return ledger.slots.filter((s): s is LedgerPick => s !== null);
}

/**
 * Decode a raw `INIT` frame. Returns null if it is not one.
 *
 * The frame is NOT just base64. Its observed shape is:
 *
 *   INIT <base64> <2048 '#' characters>
 *
 * — two space-separated fields, the second a block of `#` whose meaning we do
 * not interpret. Passing the whole tail to `atob` throws in the browser
 * ("string to be decoded is not correctly encoded"). It did NOT throw under
 * Node, because `Buffer.from(s, "base64")` silently ignores characters outside
 * the alphabet — so the unit tests passed while production failed. Take the
 * first whitespace-delimited token only.
 */
export function decodeInitFrame(frame: string, atob: (s: string) => string): Ledger | null {
  const trimmed = frame.replace(/\n$/, "");
  if (!trimmed.startsWith("INIT ")) return null;
  const b64 = trimmed.slice(5).trim().split(/\s+/)[0] ?? "";
  if (!b64) throw new LedgerFormatError("INIT frame carried no payload");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decodeLedger(bytes);
}
