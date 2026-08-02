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

  it("magic link signs in with a 302 to /; bad tokens bounce to /signin", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log");
    await app.request(
      "/api/auth/request",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "m@b.co" }) },
      env,
    );
    const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[email:console]"));
    logSpy.mockRestore();
    const link = line!.match(/link=(\S+)/)![1]!;
    const path = link.replace("http://localhost:8787", "");
    const good = await app.request(path, {}, env);
    expect(good.status).toBe(302);
    expect(good.headers.get("Location")).toBe("/");
    expect(good.headers.get("Set-Cookie")).toContain("dg_session=");
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
