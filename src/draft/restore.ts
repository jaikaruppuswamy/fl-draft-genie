// 005 T042/T043 — the 5-minute cron's draft-session sweep.
//
// PURE decision function; the impure sweep lives in src/sync/predraft.ts.
//
// This is the half of Constitution V that does not depend on anyone watching.
// A session can die with no client attached — a deploy restarts every Durable
// Object — and the owner may be looking at ESPN rather than Draft Genie when it
// happens. Nothing in the live path would notice: the tap keeps relaying into
// the log, the log keeps accepting, and the session simply never wakes up.
// The cron is what closes that gap.

import { armedDeadlinePassed } from "./arming";
import type { SessionStatus } from "./schedule";

export interface SweepRow {
  connection_id: string;
  season: number;
  status: SessionStatus;
  armed_at: string | null;
  scheduled_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
}

export type SweepAction =
  | { kind: "skip"; why: string }
  | { kind: "restore" }
  | { kind: "abort"; why: "armed_deadline" };

/**
 * What should the cron do with this session?
 *
 * `restore` is deliberately cheap and idempotent — it nudges, and the session
 * pulls whatever the log holds. A session that is perfectly healthy simply
 * finds its cursor current and commits nothing (research §7's no-op rule), so
 * sweeping every five minutes costs almost nothing.
 */
export function sweepAction(row: SweepRow, now: number): SweepAction {
  // Terminal states schedule nothing and are never resurrected. Without the
  // archived/completed checks the cron would restart a finished draft every
  // five minutes, forever.
  if (row.archived_at !== null) return { kind: "skip", why: "archived" };
  if (row.completed_at !== null) return { kind: "skip", why: "complete" };
  if (row.status === "aborted" || row.status === "unsupported" || row.status === "complete") {
    return { kind: "skip", why: row.status };
  }

  // A session stuck `armed` holds an alarm open indefinitely — ~11,000 GB-s a
  // day for a draft that was postponed and never happened. The deadline is
  // absolute for that reason; a re-published `draft_at` re-arms it naturally
  // through the ordinary sync, with no manual step.
  if (row.status === "armed" && armedDeadlinePassed(row.scheduled_at, row.armed_at, now)) {
    return { kind: "abort", why: "armed_deadline" };
  }

  return { kind: "restore" };
}
