import { Hono } from "hono";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { ingestProjections } from "../projections/ingest";
import { computeSignals } from "../signals/compute";
import { isDraftSeason, isStale, rateLimited } from "../projections/freshness";
import { getNewestSet, getServingSet } from "../db/projections";
import { currentSeason } from "../espn/leagueRef";

export function projectionRoutes() {
  const app = new Hono<AppContext>();

  // FR-016: on-demand global refresh, one per 15 minutes.
  app.post("/refresh", async (c) => {
    const t = now(c.env);
    const season = currentSeason(t);
    const newest = await getNewestSet(c.env.DB, season);
    if (rateLimited(newest?.fetched_at ?? null, t)) {
      return jsonError(
        429,
        "rate_limited",
        "Projections were refreshed within the last 15 minutes — they're already current.",
      );
    }
    const result = await ingestProjections(c.env, season, "on_demand", t);
    if (!result.ok) {
      const serving = await getServingSet(c.env.DB, season);
      return Response.json(
        {
          error: "source_unreachable",
          message: "The projection source can't be reached — showing the previous projections.",
          serving_fetched_at: serving?.fetched_at ?? null,
        },
        { status: 502 },
      );
    }
    await computeSignals(c.env, t); // 004: signals ride the same refresh (never throws)
    return c.json({ fetched_at: result.fetchedAt, player_count: result.playerCount, trigger: "on_demand" });
  });

  app.get("/status", async (c) => {
    const t = now(c.env);
    const season = currentSeason(t);
    const serving = await getServingSet(c.env.DB, season);
    return c.json({
      fetched_at: serving?.fetched_at ?? null,
      season,
      player_count: serving?.player_count ?? null,
      stale: isStale(serving?.fetched_at ?? null, t),
      next_scheduled_hint: isDraftSeason(t) ? "daily (draft season)" : "weekly (off-season)",
    });
  });

  return app;
}
