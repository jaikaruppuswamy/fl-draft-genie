import { describe, expect, it } from "vitest";
import { createEmailSender } from "../../src/email";
import { cloudflareSender } from "../../src/email/cloudflare";
import { makeEnv } from "../helpers/app";
import type { EmailSendingBinding, Env } from "../../src/env";

function stubBinding() {
  const calls: unknown[] = [];
  const binding: EmailSendingBinding = {
    async send(options) {
      calls.push(options);
      return { messageId: "test-message-id" };
    },
  };
  return { binding, calls };
}

describe("email provider selection", () => {
  it("selects the adapter by EMAIL_PROVIDER", () => {
    expect(createEmailSender(makeEnv(undefined, { EMAIL_PROVIDER: "console" }))).toBeDefined();
    const { binding } = stubBinding();
    const env: Env = makeEnv(undefined, { EMAIL_PROVIDER: "cloudflare", EMAIL: binding });
    expect(createEmailSender(env)).toBeDefined();
  });
});

describe("cloudflare email adapter", () => {
  it("sends via the binding with the configured from address", async () => {
    const { binding, calls } = stubBinding();
    const env: Env = makeEnv(undefined, {
      EMAIL: binding,
      EMAIL_FROM: "signin@neelamjai.com",
    });
    await cloudflareSender(env).sendSignIn({
      to: "user@example.com",
      code: "123456",
      magicLink: "https://draft.neelamjai.com/api/auth/magic?token=abc",
    });
    expect(calls).toHaveLength(1);
    const sent = calls[0] as { to: string; from: { email: string; name?: string }; subject: string; text: string; html?: string };
    expect(sent.to).toBe("user@example.com");
    expect(sent.from).toEqual({ email: "signin@neelamjai.com", name: "Draft Genie" });
    expect(sent.subject).toContain("123456");
    expect(sent.text).toContain("123456");
    expect(sent.text).toContain("https://draft.neelamjai.com/api/auth/magic?token=abc");
    expect(sent.html).toContain("123456");
  });

  it("fails loudly when the binding is missing", async () => {
    const env = makeEnv(undefined, { EMAIL: undefined });
    await expect(
      cloudflareSender(env).sendSignIn({ to: "a@b.co", code: "000000", magicLink: "x" }),
    ).rejects.toThrow(/binding/);
  });
});
