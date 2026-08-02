import { describe, expect, it } from "vitest";
import { api, makeEnv, signIn } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import kona from "../fixtures/espn/kona-players.json";
import proteams from "../fixtures/espn/proteams.json";

const TEST_ENV = { PROJECTION_MIN_PLAYERS: "5", NOW_OVERRIDE: "2026-08-15T12:00:00Z" };

describe("projections refresh + status contract", () => {
  it("on-demand refresh succeeds, then rate-limits within 15 minutes (429)", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    const cookie = await signIn(env, "r@b.co");

    const first = await api(env, cookie, "POST", "/api/projections/refresh");
    expect(first.status).toBe(200);
    const body = (await first.json()) as Record<string, unknown>;
    expect(body.player_count).toBe(14);
    expect(body.trigger).toBe("on_demand");
    expect(typeof body.fetched_at).toBe("string");

    const second = await api(env, cookie, "POST", "/api/projections/refresh");
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe("rate_limited");
  });

  it("allows a refresh again after the 15-minute window", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const env = makeEnv(stub, TEST_ENV);
    const cookie = await signIn(env, "r@b.co");
    expect((await api(env, cookie, "POST", "/api/projections/refresh")).status).toBe(200);

    const later = makeEnv(stub, { ...TEST_ENV, NOW_OVERRIDE: "2026-08-15T12:16:00Z" });
    expect((await api(later, cookie, "POST", "/api/projections/refresh")).status).toBe(200);
  });

  it("source down → 502 source_unreachable with the serving set preserved", async () => {
    const stub = makeEspnStub({}, { kona, proTeams: proteams });
    const env = makeEnv(stub, TEST_ENV);
    const cookie = await signIn(env, "r@b.co");
    const first = (await (await api(env, cookie, "POST", "/api/projections/refresh")).json()) as { fetched_at: string };

    stub.kona = "network";
    const later = makeEnv(stub, { ...TEST_ENV, NOW_OVERRIDE: "2026-08-15T12:20:00Z" });
    const res = await api(later, cookie, "POST", "/api/projections/refresh");
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("source_unreachable");
    expect(body.serving_fetched_at).toBe(first.fetched_at);
  });

  it("status reports freshness (null before first ingest, populated after)", async () => {
    const env = makeEnv(makeEspnStub({}, { kona, proTeams: proteams }), TEST_ENV);
    const cookie = await signIn(env, "r@b.co");

    const before = (await (await api(env, cookie, "GET", "/api/projections/status")).json()) as Record<string, unknown>;
    expect(before.fetched_at).toBeNull();
    expect(before.stale).toBe(true);

    await api(env, cookie, "POST", "/api/projections/refresh");
    const after = (await (await api(env, cookie, "GET", "/api/projections/status")).json()) as Record<string, unknown>;
    expect(after.fetched_at).not.toBeNull();
    expect(after.stale).toBe(false);
    expect(after.player_count).toBe(14);
    expect(String(after.next_scheduled_hint)).toMatch(/daily/i);
  });
});
