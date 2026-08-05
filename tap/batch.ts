// 010 T022 — batching, sequencing and the timing epoch.
//
// Three properties here are load-bearing and each comes from a specific finding:
//
//  * `session` is fresh per PAGE LOAD, never from sessionStorage — that is
//    CLONED when a tab is duplicated, so two live relays would emit colliding
//    sequence numbers (research §6).
//  * `performance.now()` STALLS across machine sleep while Date.now() jumps, so
//    a stamp anchored at page load silently runs late afterwards. We re-anchor
//    and bump an EPOCH; 005 must not compare stamps across epochs.
//  * Measured pick rate is a 1.0s minimum gap under autodraft (US1 capture), so
//    the batch window must stay well under that.

import { CONTRACT_VERSION, TAP_VERSION } from "./meta";

export const MAX_BATCH = 200;
export const BATCH_WINDOW_MS = 750;
/** A relay attempt that neither succeeds nor fails within this window is
 *  treated as failed, so the flush flag can never wedge permanently. */
export const FLUSH_TIMEOUT_MS = 15_000;

/** Re-anchor beyond this drift and treat timestamps as a new timeline. */
export const EPOCH_DRIFT_MS = 2000;

export type MessageKind = "pick" | "ledger" | "status";

export interface RelayMessage {
  v: number;
  tapVersion: string;
  install: string;
  session: string;
  seq: number;
  epoch: number;
  observedAt: string;
  transport: "ws" | "sse";
  league: { espnLeagueId: string; season: number };
  kind: MessageKind;
  payload: unknown;
}

export interface Clock {
  now(): number;
  monotonic(): number;
}

export class Sequencer {
  private seq = 0;
  private epoch = 0;
  private anchorWall: number;
  private anchorMono: number;

  constructor(
    private readonly clock: Clock,
    private readonly install: string,
    private readonly session: string,
    private readonly league: { espnLeagueId: string; season: number },
  ) {
    this.anchorWall = clock.now();
    this.anchorMono = clock.monotonic();
  }

  /** Call on resume/pageshow/online. Bumps the epoch if the clock actually moved. */
  reanchor(): boolean {
    const wall = this.clock.now();
    const mono = this.clock.monotonic();
    const drift = Math.abs(wall - this.anchorWall - (mono - this.anchorMono));
    this.anchorWall = wall;
    this.anchorMono = mono;
    if (drift > EPOCH_DRIFT_MS) {
      this.epoch++;
      return true;
    }
    return false;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  build(kind: MessageKind, payload: unknown, transport: "ws" | "sse"): RelayMessage {
    return {
      v: CONTRACT_VERSION,
      tapVersion: TAP_VERSION,
      install: this.install,
      session: this.session,
      seq: this.seq++,
      epoch: this.epoch,
      observedAt: new Date(this.clock.now()).toISOString(),
      transport,
      league: this.league,
      kind,
      payload,
    };
  }
}

/** Split a queue into wire-sized batches, preserving order. */
export function chunk(messages: RelayMessage[], max = MAX_BATCH): RelayMessage[][] {
  const out: RelayMessage[][] = [];
  for (let i = 0; i < messages.length; i += max) out.push(messages.slice(i, i + max));
  return out;
}

/** Exponential back-off with a cap, honouring a server Retry-After. */
export function backoffMs(consecutiveFailures: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, 60_000);
  return Math.min(1000 * 2 ** Math.max(0, consecutiveFailures - 1), 30_000);
}
