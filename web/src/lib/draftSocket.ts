// 005 T031 — the draft stream client.
//
// Cursor rules live in specs/005-draft-monitor/contracts/api.md. Three of them
// shape this file, and each exists to prevent a specific draft-night failure:
//
//  * DISCARD `seq <= cursor`, resync only on a true FORWARD GAP. Duplicate
//    frames are expected, and treating one as a gap produces a resync storm at
//    exactly the moment the draft is busiest.
//  * A MISMATCHED EPOCH is a reset, not an error. The epoch changes on every
//    rebuild; carrying a stale cursor across one would silently skip a
//    reconstructed draft.
//  * AFTER THREE FAILURES, fall back to polling. "Draft Genie is unreachable"
//    and "ESPN is not updating" need different remedies from the owner — wait
//    versus check ESPN — and during a live draft a wrong diagnosis costs a pick.

export interface DraftFrame {
  type: "snapshot" | "event" | "status";
  epoch: string;
  seq: number;
  [k: string]: unknown;
}

export interface DraftSocketHandlers {
  onFrame(frame: DraftFrame): void;
  /** Reachability of DRAFT GENIE — distinct from whether picks are arriving. */
  onReachability(state: "connected" | "reconnecting" | "polling"): void;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** After this many consecutive failures, poll the snapshot instead. */
const FALLBACK_AFTER = 3;
const POLL_MS = 15_000;

export function connectDraftStream(
  leagueId: string,
  handlers: DraftSocketHandlers,
): { close: () => void } {
  let ws: WebSocket | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let cursor = -1;
  let epoch: string | null = null;
  let closed = false;

  const stopPolling = () => {
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  };

  const accept = (frame: DraftFrame) => {
    if (frame.type === "snapshot") {
      // A snapshot is authoritative: adopt its epoch and cursor wholesale.
      epoch = frame.epoch;
      cursor = frame.seq;
      handlers.onFrame(frame);
      return;
    }
    if (epoch !== null && frame.epoch !== epoch) {
      // Rule 3: the session rebuilt. Drop the cursor and let the next
      // connection's snapshot re-seed it rather than replaying into a draft
      // that no longer exists.
      epoch = null;
      cursor = -1;
      reconnect();
      return;
    }
    if (frame.seq <= cursor) return; // rule 4: duplicates are normal
    cursor = frame.seq;
    handlers.onFrame(frame);
  };

  const startPolling = () => {
    if (poll !== null) return;
    handlers.onReachability("polling");
    poll = setInterval(() => {
      void fetch(`/api/leagues/${leagueId}/draft/snapshot`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((state) => {
          if (state) handlers.onFrame({ type: "snapshot", epoch: epoch ?? "", seq: cursor, state } as DraftFrame);
        })
        .catch(() => {
          /* still unreachable; the socket keeps retrying underneath */
        });
    }, POLL_MS);
  };

  const reconnect = () => {
    if (closed) return;
    failures++;
    if (failures >= FALLBACK_AFTER) startPolling();
    else handlers.onReachability("reconnecting");
    const delay = Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
    timer = setTimeout(open, delay);
  };

  function open(): void {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams();
    if (cursor >= 0) q.set("since", String(cursor));
    if (epoch !== null) q.set("epoch", epoch);
    const suffix = q.toString() ? `?${q}` : "";

    try {
      ws = new WebSocket(`${proto}://${location.host}/api/leagues/${leagueId}/draft/stream${suffix}`);
    } catch {
      reconnect();
      return;
    }

    ws.addEventListener("open", () => {
      failures = 0;
      stopPolling();
      handlers.onReachability("connected");
    });
    ws.addEventListener("message", (e) => {
      try {
        accept(JSON.parse(String(e.data)) as DraftFrame);
      } catch {
        /* a malformed frame must not tear down a working draft */
      }
    });
    ws.addEventListener("close", () => {
      if (!closed) reconnect();
    });
    // `error` is always followed by `close`; reconnecting here too would
    // double the backoff on every failure.
    ws.addEventListener("error", () => {});
  }

  open();

  return {
    close() {
      closed = true;
      stopPolling();
      if (timer !== null) clearTimeout(timer);
      ws?.close();
    },
  };
}
