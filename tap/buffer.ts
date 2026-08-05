// 010 T024 — the durable buffer, over an injected storage port so it is
// testable without a script manager.
//
// TWO RULES, both from specific failures:
//
//  1. It holds FILTERED messages, never wire frames. Buffering the raw form and
//     stripping on send would write unstripped member identifiers to disk,
//     where they outlive the tab and are invisible to any inspection of
//     transmitted traffic.
//  2. Truncate ONLY on a read acknowledgement carrying accepted-through. Never
//     on an unacknowledged send: sendBeacon returns only a boolean and
//     GM_xmlhttpRequest's post-unload behaviour is undocumented. A duplicate is
//     absorbed by the receiver's dedup; a lost pick is not recoverable.
//
// Durability ranking, stated rather than implied: ESPN's ledger is the PRIMARY
// recovery mechanism — every page load re-supplies it, and the US1 capture
// proved it recovers picks the incremental stream dropped. This buffer is
// SECONDARY, covering the one window the ledger cannot: picks observed while
// Draft Genie is unreachable in a tab that is never reloaded again.

import type { RelayMessage } from "./batch";

export interface StoragePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const MAX_BUFFERED = 2000;

export class Buffer {
  private readonly key: string;
  private items: RelayMessage[];

  constructor(
    private readonly storage: StoragePort,
    install: string,
    session: string,
  ) {
    this.key = `dg:buf:${install}:${session}`;
    this.items = this.load();
  }

  private load(): RelayMessage[] {
    try {
      const raw = this.storage.get(this.key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as RelayMessage[]) : [];
    } catch {
      // Corrupt buffer must not wedge the tap; the ledger is the primary
      // recovery path and will re-supply state on the next page load.
      return [];
    }
  }

  private persist(): void {
    try {
      this.storage.set(this.key, JSON.stringify(this.items));
    } catch {
      // Over quota: keep serving from memory rather than dropping picks.
    }
  }

  append(message: RelayMessage): void {
    this.items.push(message);
    // Oldest-first eviction only past a very high bound; losing the oldest is
    // strictly better than failing to record the newest, and the ledger covers
    // the gap on the next reconnect.
    if (this.items.length > MAX_BUFFERED) this.items = this.items.slice(-MAX_BUFFERED);
    this.persist();
  }

  pending(): RelayMessage[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }

  /** Remove everything up to and including `acceptedThrough`. Ack-driven only. */
  truncate(acceptedThrough: number): number {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.seq > acceptedThrough);
    if (this.items.length !== before) this.persist();
    return before - this.items.length;
  }

  clear(): void {
    this.items = [];
    this.storage.remove(this.key);
  }
}
