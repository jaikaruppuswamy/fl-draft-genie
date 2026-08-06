// 010 T045 — draft-end detection (FR-024, SC-014).
//
// This lives in a pure module rather than in the shell on purpose. The first
// implementation was four lines inside `main.ts`, where nothing could test it,
// and it was wrong in two ways that a single test would have caught: it never
// stopped relaying, and it could not fire at all in the draft shape we actually
// observed. Untestable placement is what let the task be marked done.
//
// Two rules carry the whole design:
//
//  1. COUNT THE UNION. Completion is measured over picks seen from the
//     incremental stream AND from the ledger together. In the observed draft 69
//     of 72 picks arrived as SELECTED frames and 3 existed only in the ledger;
//     either source counted alone stalls below the total forever, and the tap
//     would relay past the end of a finished draft.
//
//  2. NEVER GUESS THE DENOMINATOR. The total is knowable only from a ledger.
//     Until one arrives the draft's length is unknown, and unknown is reported
//     as unknown. A false "finished" is the worse error, because unlike a false
//     "still running" it stops the relay.

import type { TapState } from "./status";

/** How long a room may be silent before the tap admits it cannot tell. */
export const IDLE_UNCERTAIN_MS = 10 * 60 * 1000;

export interface DraftEndPorts {
  render(state: TapState, detail?: string): void;
  /** Deliver what is already buffered. Completion stops NEW picks, not delivery. */
  flush(): void;
  /**
   * 011 T038 — say, ON THE RELAY, that this room shows a finished draft.
   *
   * The badge and the status POST both already carry `draft-finished`, and
   * neither reaches the thing that needs it: the badge is for the human at the
   * keyboard, and the status POST is per-connection, so under fan-out it never
   * arrives at a leaguemate's session. This travels with the frames, which is
   * the only channel every session in the league actually reads.
   *
   * It makes the receiver's ledger rule DIRECT where it is present. It does not
   * replace that rule (research §2): taps update on their own schedule, so a
   * receiver that depended on this alone would be blind to every tap still
   * running yesterday's build.
   */
  announce(completion: { seen: number; total: number }): void;
  currentState(): TapState;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class DraftEnd {
  private readonly seen = new Set<number>();
  private total = 0;
  private over = false;
  private timer: unknown = null;

  constructor(
    private readonly ports: DraftEndPorts,
    private readonly idleMs: number = IDLE_UNCERTAIN_MS,
  ) {}

  /** FR-024: once true, the tap stops relaying picks. */
  get finished(): boolean {
    return this.over;
  }
  get seenCount(): number {
    return this.seen.size;
  }
  /** 0 means "not yet known" — never treated as a total. */
  get totalSlots(): number {
    return this.total;
  }

  /**
   * Record picks from either source. `total` is supplied only by the ledger.
   *
   * Identity is the player id (FR-005a): the same value in both sources, and
   * NOT the field US1 exists to disambiguate, which US1 did not resolve.
   */
  notePicks(playerIds: readonly number[], total?: number): void {
    if (typeof total === "number" && total > 0) this.total = total;
    for (const id of playerIds) this.seen.add(id);
    this.armIdle();
    if (this.over || this.total <= 0 || this.seen.size < this.total) return;
    this.over = true;
    this.clear();
    // Announced BEFORE the flush, so the signal leaves in the same delivery as
    // the frames that produced it rather than trailing a batch behind.
    this.ports.announce({ seen: this.seen.size, total: this.total });
    this.ports.render("draft-finished", `${this.seen.size}/${this.total} picks`);
    this.ports.flush();
  }

  /** Should this frame still be relayed? */
  shouldRelay(kind: "pick" | "ledger" | "status"): boolean {
    // Status keeps flowing after the end: stopping the relay must not also stop
    // the tap explaining itself.
    return !this.over || kind === "status";
  }

  /**
   * A quiet room is ambiguous — ended, paused, or a dead stream all look
   * identical. SC-014 forbids letting idle and dead read the same, so after a
   * long silence with picks seen but no confirmed completion, say so.
   */
  private armIdle(): void {
    this.clear();
    if (this.over) return;
    this.timer = this.ports.setTimer(() => {
      if (this.over || this.seen.size === 0) return;
      const s = this.ports.currentState();
      // Do not paper over a louder problem that is already displayed.
      if (s === "incompatible" || s === "version-rejected") return;
      this.ports.render("draft-end-unknown", `${this.seen.size}/${this.total || "?"} picks, then silence`);
    }, this.idleMs);
  }

  private clear(): void {
    if (this.timer !== null) {
      this.ports.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
