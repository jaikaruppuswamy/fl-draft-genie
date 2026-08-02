import type { Env } from "../env";
import type { EmailSender } from "./index";

/** Production adapter: Resend HTTPS API (research.md §6). */
export function resendSender(env: Env): EmailSender {
  return {
    async sendSignIn({ to, code, magicLink }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM ?? "Draft Genie <signin@draftgenie.app>",
          to: [to],
          subject: `Your Draft Genie sign-in code: ${code}`,
          text: `Your sign-in code is ${code} (valid 10 minutes).\n\nOr sign in directly: ${magicLink}\n`,
        }),
      });
      if (!res.ok) {
        throw new Error(`resend_failed: HTTP ${res.status}`);
      }
    },
  };
}
