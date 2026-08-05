/**
 * Cloudflare Email Sending Workers binding (send_email in wrangler.jsonc).
 * Structural type for the object-form send(); regenerate with `wrangler types`
 * if the runtime shape evolves.
 */
export interface EmailSendingBinding {
  send(options: {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  DB: D1Database;
  /** 005: the live draft session authority, one per league connection + season. */
  DRAFT_SESSION: DurableObjectNamespace;
  ASSETS?: Fetcher;
  EMAIL?: EmailSendingBinding;
  SESSION_SECRET: string;
  CREDENTIAL_KEY: string;
  RESEND_API_KEY?: string;
  EMAIL_PROVIDER?: "console" | "resend" | "cloudflare";
  EMAIL_FROM?: string;
  APP_BASE_URL?: string;
  /** Override the ESPN API host (dev/quickstart failure simulation). */
  ESPN_BASE_URL?: string;
  /** Override the tier-feed host (tests/failure simulation). */
  TIERS_BASE_URL?: string;
  /** Test-only: injected fetch implementation serving recorded fixtures. */
  ESPN_FETCH?: typeof fetch;
  /** Test-only: fixed clock (ISO string). */
  NOW_OVERRIDE?: string;
  /** Test-only: lower the ingest sanity gate for small fixtures. */
  PROJECTION_MIN_PLAYERS?: string;
}

export function now(env: Env): Date {
  return env.NOW_OVERRIDE ? new Date(env.NOW_OVERRIDE) : new Date();
}
