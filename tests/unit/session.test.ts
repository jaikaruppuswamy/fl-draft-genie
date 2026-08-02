import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "../../src/auth/session";
import { makeEnv } from "../helpers/app";

const env = makeEnv();
const t0 = new Date("2026-08-15T12:00:00Z");

describe("stateless session tokens", () => {
  it("signs and verifies", async () => {
    const token = await createSessionToken(env, "acct-1", t0);
    expect(await verifySessionToken(env, token, t0)).toBe("acct-1");
  });

  it("expires after 30 days", async () => {
    const token = await createSessionToken(env, "acct-1", t0);
    const later = new Date(t0.getTime() + 31 * 86400_000);
    expect(await verifySessionToken(env, token, later)).toBeNull();
  });

  it("rejects tampered payloads", async () => {
    const token = await createSessionToken(env, "acct-1", t0);
    const [payload, sig] = token.split(".");
    const forged = `${payload!.slice(0, -2)}AA.${sig}`;
    expect(await verifySessionToken(env, forged, t0)).toBeNull();
    expect(await verifySessionToken(env, "garbage", t0)).toBeNull();
  });

  it("rejects tokens signed with a different secret", async () => {
    const other = { ...env, SESSION_SECRET: "b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldC1vdGhlcg==" };
    const token = await createSessionToken(other, "acct-1", t0);
    expect(await verifySessionToken(env, token, t0)).toBeNull();
  });
});
