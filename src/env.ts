export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  SESSION_SECRET: string;
  CREDENTIAL_KEY: string;
  RESEND_API_KEY?: string;
  EMAIL_PROVIDER?: "console" | "resend";
  EMAIL_FROM?: string;
  APP_BASE_URL?: string;
  /** Override the ESPN API host (dev/quickstart failure simulation). */
  ESPN_BASE_URL?: string;
  /** Test-only: injected fetch implementation serving recorded fixtures. */
  ESPN_FETCH?: typeof fetch;
  /** Test-only: fixed clock (ISO string). */
  NOW_OVERRIDE?: string;
}

export function now(env: Env): Date {
  return env.NOW_OVERRIDE ? new Date(env.NOW_OVERRIDE) : new Date();
}
