import type { EmailSender } from "./index";

/** Dev/test adapter: the sign-in code and link are printed to the wrangler console. */
export function consoleSender(): EmailSender {
  return {
    async sendSignIn({ to, code, magicLink }) {
      console.log(`[email:console] to=${to} code=${code} link=${magicLink}`);
    },
  };
}
