import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { now } from "../env";
import { SESSION_COOKIE, verifySessionToken } from "../auth/session";
import { logError } from "./logging";
import { authRoutes } from "./auth";
import { credentialRoutes } from "./credentials";
import { leagueRoutes } from "./leagues";
import { boardRoutes } from "./board";
import { projectionRoutes } from "./projections";
import { accountRoutes } from "./account";

export type AppContext = {
  Bindings: Env;
  Variables: { accountId: string };
};

export function jsonError(status: number, error: string, message: string) {
  return Response.json({ error, message }, { status });
}

export function createApp() {
  const app = new Hono<AppContext>();

  app.onError((err, c) => {
    logError(`unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}`, err);
    return jsonError(500, "internal", "Something went wrong on our side. Please try again.");
  });

  app.route("/api/auth", authRoutes());

  // Everything else under /api requires a session (contracts/api.md).
  app.use("/api/*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const accountId = token ? await verifySessionToken(c.env, token, now(c.env)) : null;
    if (!accountId) {
      return jsonError(401, "unauthenticated", "Sign in to continue.");
    }
    c.set("accountId", accountId);
    await next();
  });

  app.route("/api/credentials", credentialRoutes());
  app.route("/api/leagues", leagueRoutes());
  app.route("/api/leagues", boardRoutes());
  app.route("/api/projections", projectionRoutes());
  app.route("/api/account", accountRoutes());

  app.notFound((c) => {
    if (new URL(c.req.url).pathname.startsWith("/api/")) {
      return jsonError(404, "not_found", "No such API endpoint.");
    }
    // Non-API paths are served by the static assets platform config; reaching
    // here means assets are absent (e.g. tests) — return a plain 404.
    return c.text("Not found", 404);
  });

  return app;
}
