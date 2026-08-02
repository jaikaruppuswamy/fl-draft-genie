// Re-sync of an existing connection (FR-018/FR-019/FR-020).
// Failure semantics: the previous snapshot is never discarded; only the
// connection's last_sync_status flips. ESPN 401/403 additionally marks the
// account's credentials failing (FR-008).

import type { Env } from "../env";
import { createEspnClient } from "../espn/client";
import { EspnError } from "../espn/types";
import { parseLeague } from "../espn/parsers";
import { setCredentialStatus } from "../db/credentials";
import { recordSyncFailure, recordSyncSuccess, type ConnectionRow } from "../db/leagues";
import { loadDecryptedCredentials } from "./connect";
import { logError, logInfo } from "../api/logging";

/** Politeness floor between full syncs of one league (research.md §7). */
const MIN_SYNC_INTERVAL_MS = 30_000;

export type RefreshResult = "ok" | "failed" | "skipped_recent";

export async function refreshConnection(
  env: Env,
  connection: ConnectionRow,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<RefreshResult> {
  if (
    !opts.force &&
    connection.last_sync_at &&
    now.getTime() - new Date(connection.last_sync_at).getTime() < MIN_SYNC_INTERVAL_MS
  ) {
    return "skipped_recent";
  }

  const loaded = await loadDecryptedCredentials(env, connection.account_id);
  if (!loaded) {
    await recordSyncFailure(env.DB, connection.id);
    return "failed";
  }

  const client = createEspnClient(env, loaded.creds);
  try {
    const raw = await client.fetchLeague(connection.season, connection.espn_league_id, [
      "mSettings",
      "mTeam",
      "mDraftDetail",
    ]);
    await recordSyncSuccess(env.DB, connection.id, parseLeague(raw), now);
    await setCredentialStatus(env.DB, connection.account_id, "working", now);
    logInfo(`synced league ${connection.espn_league_id} (connection ${connection.id})`);
    return "ok";
  } catch (err) {
    await recordSyncFailure(env.DB, connection.id);
    if (err instanceof EspnError && err.code === "espn_rejected") {
      await setCredentialStatus(env.DB, connection.account_id, "failing", now);
    }
    logError(`sync failed for league ${connection.espn_league_id}`, err);
    return "failed";
  }
}
