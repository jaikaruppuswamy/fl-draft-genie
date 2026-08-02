import { Hono } from "hono";
import { z } from "zod";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { issueLoginToken, verifyCode, verifyMagicLink } from "../auth/tokens";
import { clearSessionCookieHeader, createSessionToken, sessionCookieHeader } from "../auth/session";
import { createEmailSender } from "../email";
import { logInfo } from "./logging";

const emailSchema = z.string().trim().toLowerCase().email();

export function authRoutes() {
  const app = new Hono<AppContext>();

  app.post("/request", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ email: emailSchema }).safeParse(body);
    if (!parsed.success) {
      return jsonError(422, "invalid_email", "Enter a valid email address.");
    }
    const email = parsed.data.email;
    const result = await issueLoginToken(c.env, email, now(c.env));
    if (!result.ok) {
      return jsonError(429, "rate_limited", "Too many sign-in requests. Wait a few minutes.");
    }
    const base = c.env.APP_BASE_URL ?? new URL(c.req.url).origin;
    const magicLink = `${base}/api/auth/magic?token=${result.linkToken}`;
    await createEmailSender(c.env).sendSignIn({ to: email, code: result.code, magicLink });
    logInfo(`sign-in requested for ${email}`);
    // Always 204 for well-formed emails: no account enumeration (contracts/api.md).
    return c.body(null, 204);
  });

  app.post("/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ email: emailSchema, code: z.string() }).safeParse(body);
    if (!parsed.success) {
      return jsonError(422, "invalid_code", "That code didn't work. Re-enter it or request a new one.");
    }
    const result = await verifyCode(c.env, parsed.data.email, parsed.data.code, now(c.env));
    if (!result.ok) {
      return jsonError(422, "invalid_code", "That code didn't work. Re-enter it or request a new one.");
    }
    const token = await createSessionToken(c.env, result.account.id, now(c.env));
    c.header("Set-Cookie", sessionCookieHeader(token, c.req.url));
    return c.json({ account: { id: result.account.id, email: result.account.email } });
  });

  app.get("/magic", async (c) => {
    const linkToken = c.req.query("token") ?? "";
    const result = await verifyMagicLink(c.env, linkToken, now(c.env));
    if (!result.ok) {
      return c.redirect("/signin?error=expired_link", 302);
    }
    const token = await createSessionToken(c.env, result.account.id, now(c.env));
    c.header("Set-Cookie", sessionCookieHeader(token, c.req.url));
    return c.redirect("/", 302);
  });

  app.post("/signout", async (c) => {
    c.header("Set-Cookie", clearSessionCookieHeader(c.req.url));
    return c.body(null, 204);
  });

  return app;
}
