import { Hono } from "hono";
import { z } from "zod";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { maskSwid, normalizeEspnS2, normalizeSwid } from "../auth/normalizeCookies";
import { encryptSecret } from "../crypto/credentials";
import { getCredentials, upsertCredentials } from "../db/credentials";
import { listConnectionsByAccount } from "../db/leagues";
import { createEspnClient } from "../espn/client";
import { EspnError } from "../espn/types";
import { currentSeason } from "../espn/leagueRef";
import { refreshConnection } from "../sync/refresh";

export function credentialRoutes() {
  const app = new Hono<AppContext>();

  // PUT /api/credentials — validate against ESPN, then store encrypted (FR-004/005/006).
  // On replacement, re-validate every connected league (FR-007).
  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ espn_s2: z.string(), swid: z.string() }).safeParse(body);
    if (!parsed.success) {
      return jsonError(422, "malformed_credentials", "Both espn_s2 and SWID values are required.");
    }
    const espnS2 = normalizeEspnS2(parsed.data.espn_s2);
    const swid = normalizeSwid(parsed.data.swid);
    if (!espnS2 || !swid) {
      return jsonError(
        422,
        "malformed_credentials",
        "Those values don't look like ESPN cookies — re-copy espn_s2 and SWID from your browser.",
      );
    }

    const t = now(c.env);
    const probe = createEspnClient(c.env, { espnS2, swid });
    try {
      await probe.probeCredentials(currentSeason(t));
    } catch (err) {
      if (err instanceof EspnError && err.code === "espn_rejected") {
        return jsonError(
          422,
          "espn_rejected",
          "ESPN rejected these cookies. They may be expired — sign in to fantasy.espn.com and copy fresh values.",
        );
      }
      return jsonError(502, "espn_unreachable", "ESPN can't be reached right now. Nothing was stored — try again.");
    }

    const accountId = c.get("accountId");
    await upsertCredentials(
      c.env.DB,
      accountId,
      await encryptSecret(c.env.CREDENTIAL_KEY, espnS2),
      await encryptSecret(c.env.CREDENTIAL_KEY, swid),
      maskSwid(swid),
      t,
    );

    // FR-007: replacement re-validates all connected leagues with the new pair.
    const connections = await listConnectionsByAccount(c.env.DB, accountId);
    for (const connection of connections) {
      await refreshConnection(c.env, connection, t, { force: true });
    }

    const row = await getCredentials(c.env.DB, accountId);
    return c.json({
      status: row?.status ?? "working",
      swid_masked: row?.swid_masked ?? maskSwid(swid),
      last_validated_at: row?.last_validated_at ?? t.toISOString(),
      leagues_revalidated: connections.length,
    });
  });

  app.get("/", async (c) => {
    const row = await getCredentials(c.env.DB, c.get("accountId"));
    return c.json({
      present: row !== null,
      status: row?.status ?? null,
      swid_masked: row?.swid_masked ?? null,
      last_validated_at: row?.last_validated_at ?? null,
    });
  });

  return app;
}
