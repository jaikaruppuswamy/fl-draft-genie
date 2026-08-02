import type { Env } from "../env";
import type { EmailSender } from "./index";

/**
 * Cloudflare Email Sending adapter (Workers binding — no API key).
 * Requires the `send_email` binding in wrangler.jsonc and the EMAIL_FROM
 * domain onboarded via `wrangler email sending enable <domain>`.
 */
export function cloudflareSender(env: Env): EmailSender {
  return {
    async sendSignIn({ to, code, magicLink }) {
      if (!env.EMAIL) throw new Error("send_email binding EMAIL is not configured");
      await env.EMAIL.send({
        to,
        from: { email: env.EMAIL_FROM ?? "signin@neelamjai.com", name: "Draft Genie" },
        subject: `Your Draft Genie sign-in code: ${code}`,
        text: `Your sign-in code is ${code} (valid 10 minutes).\n\nOr sign in directly: ${magicLink}\n\nIf you didn't request this, ignore this email.`,
        html: `<p>Your sign-in code is <strong style="font-size:1.3em">${code}</strong> (valid 10 minutes).</p><p><a href="${magicLink}">Or click here to sign in directly</a>.</p><p style="color:#888">If you didn't request this, ignore this email.</p>`,
      });
    },
  };
}
