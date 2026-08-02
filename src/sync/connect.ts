// League connect flow (FR-010..FR-016): validate → sync → identify team →
// create connection + snapshot atomically. No partial connections.

import type { Env } from "../env";
import { createEspnClient, type EspnCredentials } from "../espn/client";
import { EspnError } from "../espn/types";
import { parseLeague, type ParsedLeague, type TeamSnapshot } from "../espn/parsers";
import { identifyMyTeam } from "../espn/identifyTeam";
import { currentSeason, parseLeagueRef } from "../espn/leagueRef";
import { decryptSecret } from "../crypto/credentials";
import { getCredentials, setCredentialStatus } from "../db/credentials";
import { createConnectionWithSnapshot, findConnection, type ConnectionRow } from "../db/leagues";
import { createConnectToken, verifyConnectToken } from "../auth/connectToken";

export type ConnectOutcome =
  | { kind: "connected"; connection: ConnectionRow }
  | { kind: "team_choice_required"; connectToken: string; teams: TeamSnapshot[] }
  | {
      kind: "error";
      code:
        | "no_credentials"
        | "credentials_failing"
        | "unparseable_ref"
        | "league_not_found"
        | "not_football"
        | "wrong_season"
        | "already_connected"
        | "espn_rejected"
        | "espn_unreachable"
        | "invalid_team"
        | "expired_connect_token";
    };

export async function loadDecryptedCredentials(
  env: Env,
  accountId: string,
): Promise<{ creds: EspnCredentials; status: "working" | "failing" } | null> {
  const row = await getCredentials(env.DB, accountId);
  if (!row) return null;
  return {
    creds: {
      espnS2: await decryptSecret(env.CREDENTIAL_KEY, row.s2_ciphertext),
      swid: await decryptSecret(env.CREDENTIAL_KEY, row.swid_ciphertext),
    },
    status: row.status,
  };
}

async function fetchAndValidateLeague(
  env: Env,
  accountId: string,
  creds: EspnCredentials,
  leagueId: string,
  season: number,
  now: Date,
): Promise<{ parsed: ParsedLeague; raw: Awaited<ReturnType<ReturnType<typeof createEspnClient>["fetchLeague"]>> } | { kind: "error"; code: Extract<ConnectOutcome, { kind: "error" }>["code"] }> {
  const client = createEspnClient(env, creds);
  try {
    const raw = await client.fetchLeague(season, leagueId, ["mSettings", "mTeam", "mDraftDetail"]);
    if (raw.gameId !== undefined && raw.gameId !== 1) {
      return { kind: "error", code: "not_football" };
    }
    if (raw.seasonId !== season || raw.status?.isActive === false) {
      return { kind: "error", code: "wrong_season" };
    }
    await setCredentialStatus(env.DB, accountId, "working", now);
    return { parsed: parseLeague(raw), raw };
  } catch (err) {
    if (err instanceof EspnError) {
      if (err.code === "espn_rejected") {
        // FR-008: any ESPN rejection flips the stored pair to failing.
        await setCredentialStatus(env.DB, accountId, "failing", now);
      }
      return { kind: "error", code: err.code };
    }
    throw err;
  }
}

export async function connectLeague(
  env: Env,
  accountId: string,
  leagueRefRaw: string,
  now: Date,
): Promise<ConnectOutcome> {
  const loaded = await loadDecryptedCredentials(env, accountId);
  if (!loaded) return { kind: "error", code: "no_credentials" };

  const ref = parseLeagueRef(leagueRefRaw);
  if (!ref) return { kind: "error", code: "unparseable_ref" };
  const season = ref.season ?? currentSeason(now);
  if (ref.season && ref.season !== currentSeason(now)) {
    return { kind: "error", code: "wrong_season" };
  }

  if (await findConnection(env.DB, accountId, ref.leagueId, season)) {
    return { kind: "error", code: "already_connected" };
  }

  const result = await fetchAndValidateLeague(env, accountId, loaded.creds, ref.leagueId, season, now);
  if ("kind" in result) return result;

  const myTeamId = identifyMyTeam(result.raw, loaded.creds.swid);
  if (myTeamId === null) {
    return {
      kind: "team_choice_required",
      connectToken: await createConnectToken(
        env,
        { account_id: accountId, league_id: ref.leagueId, season },
        now,
      ),
      teams: result.parsed.teams,
    };
  }

  const connection = await createConnectionWithSnapshot(
    env.DB,
    accountId,
    ref.leagueId,
    season,
    myTeamId,
    "auto",
    result.parsed,
    now,
  );
  return { kind: "connected", connection };
}

export async function completeConnect(
  env: Env,
  accountId: string,
  connectToken: string,
  espnTeamId: number,
  now: Date,
): Promise<ConnectOutcome> {
  const claim = await verifyConnectToken(env, connectToken, now);
  if (!claim || claim.account_id !== accountId) {
    return { kind: "error", code: "expired_connect_token" };
  }
  const loaded = await loadDecryptedCredentials(env, accountId);
  if (!loaded) return { kind: "error", code: "no_credentials" };

  if (await findConnection(env.DB, accountId, claim.league_id, claim.season)) {
    return { kind: "error", code: "already_connected" };
  }

  const result = await fetchAndValidateLeague(
    env,
    accountId,
    loaded.creds,
    claim.league_id,
    claim.season,
    now,
  );
  if ("kind" in result) return result;

  if (!result.parsed.teams.some((t) => t.espn_team_id === espnTeamId)) {
    return { kind: "error", code: "invalid_team" };
  }

  const connection = await createConnectionWithSnapshot(
    env.DB,
    accountId,
    claim.league_id,
    claim.season,
    espnTeamId,
    "manual",
    result.parsed,
    now,
  );
  return { kind: "connected", connection };
}
