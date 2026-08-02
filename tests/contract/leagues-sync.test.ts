import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { listConnectionsByAccount } from "../../src/db/leagues";
import { refreshConnection } from "../../src/sync/refresh";
import ppr from "../fixtures/espn/settings-team.json";

describe("league sync contract (FR-018/FR-020/FR-008)", () => {
  it("POST /:id/sync refreshes the snapshot with new ESPN data", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "u@b.co");
    const league = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };

    const renamed = structuredClone(ppr) as Record<string, any>;
    renamed.settings.name = "Gridiron Gurus (Renamed)";
    renamed.settings.scoringSettings.scoringItems.find((i: { statId: number }) => i.statId === 53)!.points = 0.5;
    stub.leagues["1001"] = renamed;

    const res = await api(env, cookie, "POST", `/api/leagues/${league.id}/sync`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.name).toBe("Gridiron Gurus (Renamed)");
    expect(body.scoring_summary).toBe("0.5 PPR · 16 slots");
    expect(body.sync_status).toBe("ok");
    expect(body.warning).toBeUndefined();
  });

  it("failed sync keeps stale data labeled with age + warning, never 5xx (FR-020)", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "u@b.co");
    const league = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };

    stub.leagues["1001"] = "network";
    const res = await api(env, cookie, "POST", `/api/leagues/${league.id}/sync`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.sync_status).toBe("failed");
    expect(body.warning).toMatch(/last synced/i);
    expect(body.name).toBe("Gridiron Gurus"); // stale snapshot intact
    expect(typeof body.snapshot_age_seconds).toBe("number");
  });

  it("ESPN 401 during sync flips credentials to failing (FR-008)", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "u@b.co");
    const league = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };

    stub.leagues["1001"] = 401;
    const res = await api(env, cookie, "POST", `/api/leagues/${league.id}/sync`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.sync_status).toBe("failed");
    expect(body.credentials_status).toBe("failing");
    const creds = (await (await api(env, cookie, "GET", "/api/credentials")).json()) as { status: string };
    expect(creds.status).toBe("failing");
  });

  it("non-forced refresh within 30 s is skipped (polite polling, research.md §7)", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "u@b.co");
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });
    const connection = (await listConnectionsByAccount(env.DB, (await connectionAccount(env, cookie)) ?? ""))[0]!;
    const callsBefore = stub.requests.length;
    const result = await refreshConnection(env, connection, new Date(new Date(connection.last_sync_at!).getTime() + 10_000));
    expect(result).toBe("skipped_recent");
    expect(stub.requests.length).toBe(callsBefore);
  });
});

async function connectionAccount(env: ReturnType<typeof makeEnv>, cookie: string): Promise<string | null> {
  // The account id isn't exposed by the API; recover it from the connection table.
  const row = await env.DB.prepare("SELECT account_id FROM league_connections LIMIT 1").first<{ account_id: string }>();
  void cookie;
  return row?.account_id ?? null;
}
