import type { Env } from "../env";
import { consoleSender } from "./console";
import { resendSender } from "./resend";

export interface SignInEmail {
  to: string;
  code: string;
  magicLink: string;
}

export interface EmailSender {
  sendSignIn(email: SignInEmail): Promise<void>;
}

export function createEmailSender(env: Env): EmailSender {
  if (env.EMAIL_PROVIDER === "resend") return resendSender(env);
  return consoleSender();
}
