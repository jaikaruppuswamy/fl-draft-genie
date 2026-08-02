import { Hono } from "hono";
import type { AppContext } from "./app";
import { clearSessionCookieHeader } from "../auth/session";
import { deleteAccount } from "../db/accounts";

export function accountRoutes() {
  const app = new Hono<AppContext>();

  // FR-009: deletes the account and (via FK cascade) credentials, connections, snapshots.
  app.delete("/", async (c) => {
    await deleteAccount(c.env.DB, c.get("accountId"));
    c.header("Set-Cookie", clearSessionCookieHeader(c.req.url));
    return c.body(null, 204);
  });

  return app;
}
