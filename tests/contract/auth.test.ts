import { describe, expect, it, vi } from "vitest";
import { api, app, cookieFrom, makeEnv, signIn } from "../helpers/app";

describe("auth contract (contracts/api.md)", () => {
  it("request → verify sets a session cookie and returns the account", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log");
    const res = await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "Jai@Example.com" }) },
      env,
    );
    expect(res.status).toBe(204);
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[email:console]"));
    logSpy.mockRestore();
    const code = line!.match(/code=(\d{6})/)![1]!;
    const verify = await app.request(
      "/api/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "jai@example.com", code }) },
      env,
    );
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { account: { email: string } };
    expect(body.account.email).toBe("jai@example.com");
    expect(verify.headers.get("Set-Cookie")).toContain("dg_session=");
    expect(verify.headers.get("Set-Cookie")).toContain("HttpOnly");
  });

  it("rejects malformed emails with 422 invalid_email", async () => {
    const res = await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nope" }) },
      makeEnv(),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_email");
  });

  it("rejects a wrong code with 422 invalid_code", async () => {
    const env = makeEnv();
    await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) },
      env,
    );
    const res = await app.request(
      "/api/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co", code: "000000" }) },
      env,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_code");
  });

  it("rejects an expired code", async () => {
    const env = makeEnv(undefined, { NOW_OVERRIDE: "2026-08-15T12:00:00Z" });
    const logSpy = vi.spyOn(console, "log");
    await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) },
      env,
    );
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[email:console]"));
    logSpy.mockRestore();
    const code = line!.match(/code=(\d{6})/)![1]!;
    const later = makeEnv(undefined, { NOW_OVERRIDE: "2026-08-15T12:11:00Z" }); // 11 min > 10 min TTL
    const res = await app.request(
      "/api/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co", code }) },
      later,
    );
    expect(res.status).toBe(422);
  });

  it("codes are single-use", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log");
    await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) },
      env,
    );
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[email:console]"));
    logSpy.mockRestore();
    const code = line!.match(/code=(\d{6})/)![1]!;
    const body = { email: "a@b.co", code };
    const first = await app.request(
      "/api/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      "/api/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      env,
    );
    expect(second.status).toBe(422);
  });

  it("rate-limits after 3 outstanding requests (429)", async () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        "/api/auth/request",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "burst@b.co" }) },
        env,
      );
      expect(res.status).toBe(204);
    }
    const fourth = await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "burst@b.co" }) },
      env,
    );
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { error: string }).error).toBe("rate_limited");
  });

  // Opening a magic link no longer signs anyone in.
  //
  // It used to: GET /api/auth/magic verified the token and set the session
  // cookie. A GET is a top-level navigation, and `SameSite` governs whether
  // cookies are SENT cross-site, not whether a response from our own origin may
  // SET one — so any page the owner visited could run
  //   location = 'https://draft.neelamjai.com/api/auth/magic?token=<theirs>'
  // and silently sign that browser into the attacker's account.
  //
  // It was invisible: the header reads the email from localStorage, written
  // only on the code path, so the victim kept seeing their own address while
  // acting in someone else's account. US3 would have made it mint a 180-day
  // relay credential for the attacker with nothing shown.
  async function magicLinkFor(env: ReturnType<typeof makeEnv>, email: string): Promise<string> {
    const logSpy = vi.spyOn(console, "log");
    await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) },
      env,
    );
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[email:console]"));
    logSpy.mockRestore();
    return line!.match(/link=(\S+)/)![1]!.replace("http://localhost:8787", "");
  }

  it("does NOT create a session on the GET — the whole login-CSRF fix", async () => {
    const env = makeEnv();
    const path = await magicLinkFor(env, "m@b.co");

    const res = await app.request(path, {}, env);
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("dg_session=");
  });

  it("shows a confirmation naming the account instead", async () => {
    // Naming it is half the fix. Under a flow where nothing is displayed, this
    // string is the only thing that can make a wrong account visible.
    const env = makeEnv();
    const path = await magicLinkFor(env, "m@b.co");

    const res = await app.request(path, {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("m@b.co");
  });

  it("REFUSES a cross-site POST that skips the confirmation", async () => {
    // The attack, moved one step along. Having lost the GET, an attacker can
    // still submit a form to our origin carrying their own link token. The
    // confirmation cookie is what stops it: SameSite=Lax withholds cookies on a
    // cross-site POST, so the submitted value has nothing to match.
    const env = makeEnv();
    const path = await magicLinkFor(env, "m@b.co");
    const token = new URL(`http://x${path}`).searchParams.get("token")!;

    const forged = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, confirm: "guessed" }).toString(),
      },
      env,
    );
    expect(forged.headers.get("Set-Cookie") ?? "").not.toContain("dg_session=");
    // It bounces to the same place a spent link does — a forged submission and
    // an expired one are not worth telling apart for the sender.
    expect(forged.headers.get("Location")).toBe("/signin?error=expired_link");
  });

  it("SIGNS IN when the confirmation is genuine — PROVES the guard is not blanket", async () => {
    // Without this, every refusal above passes against an endpoint that refuses
    // everything, and nobody could sign in by email at all.
    const env = makeEnv();
    const path = await magicLinkFor(env, "m@b.co");
    const token = new URL(`http://x${path}`).searchParams.get("token")!;

    const page = await app.request(path, {}, env);
    const setCookie = page.headers.get("Set-Cookie")!;
    const nonce = /dg_confirm=([^;]+)/.exec(setCookie)![1]!;

    const res = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `dg_confirm=${nonce}` },
        body: new URLSearchParams({ token, confirm: nonce }).toString(),
      },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("dg_session=");
  });

  it("still works when the link is opened on a DIFFERENT device", async () => {
    // The reason this design was chosen over binding the link to the requesting
    // browser: requesting on a phone and opening on a laptop must keep working.
    // The confirmation carries no memory of who asked.
    const env = makeEnv();
    const path = await magicLinkFor(env, "roam@b.co");
    const token = new URL(`http://x${path}`).searchParams.get("token")!;

    // A browser that never saw /api/auth/request.
    const page = await app.request(path, {}, env);
    const nonce = /dg_confirm=([^;]+)/.exec(page.headers.get("Set-Cookie")!)![1]!;
    const res = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `dg_confirm=${nonce}` },
        body: new URLSearchParams({ token, confirm: nonce }).toString(),
      },
      env,
    );
    expect(res.status).toBe(302);
  });

  it("never lets the confirmation page be cached", async () => {
    // Its body carries a LIVE, unconsumed link token — `peekMagicLink`
    // deliberately stopped consuming so the page could name the account. A 200
    // holding both a Set-Cookie and a redeemable credential is the last thing a
    // shared browser or an intermediary should keep.
    const env = makeEnv();
    const path = await magicLinkFor(env, "cache@b.co");
    const res = await app.request(path, {}, env);

    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("bounces a bad or spent token to /signin", async () => {
    const env = makeEnv();
    const bad = await app.request("/api/auth/magic?token=deadbeef", {}, env);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("Location")).toBe("/signin?error=expired_link");
  });

  it("signout clears the cookie; protected endpoints 401 without a session", async () => {
    const env = makeEnv();
    const cookie = await signIn(env, "s@b.co");
    const out = await api(env, cookie, "POST", "/api/auth/signout");
    expect(out.status).toBe(204);
    expect(cookieFrom(out)).toBe("dg_session=");
    const denied = await app.request("/api/leagues", {}, env);
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: string }).error).toBe("unauthenticated");
  });
});
