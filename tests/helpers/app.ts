// Shared harness: real Worker env (D1, secrets) from cloudflare:test, the Hono
// app called in-process, ESPN stubbed per test, and a cookie-jar sign-in flow
// that exercises the real email path (code captured from the console adapter).

import { env as testEnv } from "cloudflare:test";
import { vi } from "vitest";
import { createApp } from "../../src/api/app";
import type { Env } from "../../src/env";
import type { EspnStub } from "./espnStub";

export const MY_SWID = "{11111111-2222-3333-4444-555555555555}";
export const MY_S2 =
  "AEB%2FtestS2valueAAAA1111222233334444555566667777888899990000aaaabbbbccccddddeeee%2Fabc";

export const app = createApp();

export function makeEnv(stub?: EspnStub, overrides: Partial<Env> = {}): Env {
  return {
    ...(testEnv as unknown as Env),
    ...(stub ? { ESPN_FETCH: stub.fetch } : {}),
    ...overrides,
  };
}

export function cookieFrom(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  return set.split(";")[0] ?? "";
}

/** Full passwordless sign-in; returns the session Cookie header value. */
export async function signIn(env: Env, email: string): Promise<string> {
  const logSpy = vi.spyOn(console, "log");
  const reqRes = await app.request(
    "/api/auth/request",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) },
    env,
  );
  if (reqRes.status !== 204) throw new Error(`auth request failed: ${reqRes.status}`);
  const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[email:console]"));
  logSpy.mockRestore();
  const code = line?.match(/code=(\d{6})/)?.[1];
  if (!code) throw new Error("sign-in code not found in console email output");
  const verifyRes = await app.request(
    "/api/auth/verify",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }) },
    env,
  );
  if (verifyRes.status !== 200) throw new Error(`verify failed: ${verifyRes.status}`);
  return cookieFrom(verifyRes);
}

export async function api(
  env: Env,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        Cookie: cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}

/** Sign in + store working credentials in one call. */
export async function signInWithCreds(env: Env, email: string): Promise<string> {
  const cookie = await signIn(env, email);
  const res = await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID });
  if (res.status !== 200) throw new Error(`credential setup failed: ${res.status}`);
  return cookie;
}
