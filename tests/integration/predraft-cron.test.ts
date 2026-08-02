// US3: the 5-minute cron's pre-draft window scan (FR-019, SC-004) — leagues
// inside [now−15 m, now+75 m] refresh automatically; a just-published draft
// order lands within one tick.

import { describe, expect, it } from "vitest";
import { api, makeEnv, signInWithCreds } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { scanPreDraftWindow } from "../../src/sync/predraft";
import ppr from "../fixtures/espn/settings-team.json";
import half from "../fixtures/espn/settings-team-half.json";
import published from "../fixtures/espn/draftdetail-published.json";

const DRAFT_MS = 1788486000000; // settings-team.json draft time; half drafts 60 min later

describe("US3: pre-draft window auto-sync", () => {
  it("refreshes only leagues inside the window and picks up the published order", async () => {
    const stub = makeEspnStub({ "1001": ppr, "2002": half });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "cron@b.co");
    const inWindow = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "2002" });

    // ESPN publishes the order; next cron tick is 70 min before league 1001's draft.
    stub.leagues["1001"] = published;
    const requestsBefore = stub.requests.length;
    const tick = new Date(DRAFT_MS - 70 * 60_000);
    const refreshed = await scanPreDraftWindow(env, tick);

    // League 2002 drafts 60 min later → 130 min out → outside the 75-min window.
    expect(refreshed).toBe(1);
    expect(stub.requests.length).toBe(requestsBefore + 1);

    const detail = (await (await api(env, cookie, "GET", `/api/leagues/${inWindow.id}`)).json()) as Record<string, any>;
    expect(detail.draft.order_published).toBe(true);
    expect(detail.draft_order).toEqual([4, 1, 7, 2, 5, 3, 6, 8, 9, 10, 11, 12]);
  });

  it("ignores leagues whose draft already completed", async () => {
    const done = structuredClone(published) as Record<string, any>;
    done.draftDetail = { drafted: true, inProgress: false };
    const stub = makeEspnStub({ "1001": done });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "cron2@b.co");
    await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" });

    const requestsBefore = stub.requests.length;
    const refreshed = await scanPreDraftWindow(env, new Date(DRAFT_MS - 60 * 60_000));
    expect(refreshed).toBe(0);
    expect(stub.requests.length).toBe(requestsBefore);
  });

  it("a failed window refresh leaves the last snapshot serving (FR-020)", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const cookie = await signInWithCreds(env, "cron3@b.co");
    const league = (await (await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" })).json()) as { id: string };

    stub.leagues["1001"] = "network";
    await scanPreDraftWindow(env, new Date(DRAFT_MS - 70 * 60_000));

    const detail = (await (await api(env, cookie, "GET", `/api/leagues/${league.id}`)).json()) as Record<string, any>;
    expect(detail.sync_status).toBe("failed");
    expect(detail.name).toBe("Gridiron Gurus");
  });
});
