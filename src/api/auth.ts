import { Hono } from "hono";
import { z } from "zod";
import { now } from "../env";
import type { AppContext } from "./app";
import { jsonError } from "./app";
import { issueLoginToken, peekMagicLink, verifyCode, verifyMagicLink } from "../auth/tokens";
import { clearSessionCookieHeader, createSessionToken, sessionCookieHeader } from "../auth/session";
import { CONFIRM_COOKIE, clearConfirmCookieHeader, confirmCookieHeader, confirmPage, readCookie } from "../auth/confirm";
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

  /**
   * Opening a magic link does NOT sign anyone in. It asks.
   *
   * It used to. A GET is a top-level navigation, and `SameSite` governs whether
   * cookies are SENT cross-site — not whether a response from our own origin may
   * SET one. So any page the owner merely visited could run
   *
   *   location = "https://draft.neelamjai.com/api/auth/magic?token=<attacker's>"
   *
   * and silently sign that browser into the attacker's account. Textbook login
   * CSRF, and invisible here: the header reads the address from localStorage,
   * written only on the code path, so the victim kept seeing their own email
   * while acting in someone else's account.
   *
   * US3 is what made it urgent. A one-click relay credential, minted with
   * nothing displayed by design, would have been minted for the attacker.
   *
   * Two things close it, and both are needed:
   *
   *   * the state change moved to a POST carrying a confirmation nonce that is
   *     also set as a cookie. SameSite=Lax withholds cookies on a cross-site
   *     POST, so a forged submission has nothing to match;
   *   * the page NAMES THE ACCOUNT. Under a flow where nothing is shown, that
   *     string is the only thing that can make a wrong account visible.
   *
   * Deliberately server-rendered rather than an SPA route: the link token never
   * reaches client-side JavaScript, and this page must work before any bundle
   * has loaded.
   */
  app.get("/magic", async (c) => {
    const linkToken = c.req.query("token") ?? "";
    const peek = await peekMagicLink(c.env, linkToken, now(c.env));
    if (!peek.ok) return c.redirect("/signin?error=expired_link", 302);

    const nonce = crypto.randomUUID();
    c.header("Set-Cookie", confirmCookieHeader(nonce, c.req.url));
    c.header("Content-Type", "text/html; charset=utf-8");
    // The body carries a LIVE, UNCONSUMED link token: `peekMagicLink`
    // deliberately stopped consuming so this page could name the account. Under
    // the old design the token was spent before any HTML existed. A 200 that
    // carries both a Set-Cookie and a redeemable credential is the last
    // response you want a shared browser or an intermediary holding on to.
    c.header("Cache-Control", "no-store");
    // No frame may host this: a framed confirmation is a clickjacked one.
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Frame-Options", "DENY");
    return c.body(confirmPage(peek.email, linkToken, nonce));
  });

  /** The state change. Same-site only, by construction. */
  app.post("/magic", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const linkToken = String(form.token ?? "");
    const submitted = String(form.confirm ?? "");
    const cookie = readCookie(c.req.header("Cookie") ?? "", CONFIRM_COOKIE);

    // Both halves must be present AND equal. A cross-site POST reaches here
    // without the cookie, so there is nothing for the submitted value to match.
    if (!submitted || !cookie || submitted !== cookie) {
      return c.redirect("/signin?error=expired_link", 302);
    }

    const result = await verifyMagicLink(c.env, linkToken, now(c.env));
    if (!result.ok) return c.redirect("/signin?error=expired_link", 302);

    const token = await createSessionToken(c.env, result.account.id, now(c.env));
    // APPEND, not set. A second `c.header("Set-Cookie", …)` replaces the first,
    // which silently dropped the session cookie and signed nobody in.
    c.header("Set-Cookie", sessionCookieHeader(token, c.req.url));
    c.header("Set-Cookie", clearConfirmCookieHeader(c.req.url), { append: true });
    return c.redirect("/", 302);
  });

  app.post("/signout", async (c) => {
    c.header("Set-Cookie", clearSessionCookieHeader(c.req.url));
    return c.body(null, 204);
  });

  return app;
}
