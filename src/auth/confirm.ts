// The magic-link confirmation: the page that turns a link into a session.
//
// It exists because opening a link must not BE the sign-in. See the comment on
// `GET /api/auth/magic` for the login-CSRF this closes.
//
// Server-rendered on purpose. The link token never reaches client-side
// JavaScript, and this page has to work before any bundle has loaded — it is
// the first thing a new user sees.

/** Short-lived, and matched against the value submitted with the form. */
export const CONFIRM_COOKIE = "dg_confirm";

/** Long enough to read a sentence and click; short enough not to linger. */
const CONFIRM_TTL_S = 900;

function secureSuffix(url: string): string {
  // Mirrors the session cookie's own rule so local development still works.
  return new URL(url).protocol === "https:" ? "; Secure" : "";
}

export function confirmCookieHeader(nonce: string, url: string): string {
  // HttpOnly so no script can read it, SameSite=Lax so it accompanies the
  // same-site form POST and is withheld from a cross-site one. That asymmetry
  // IS the protection.
  return `${CONFIRM_COOKIE}=${nonce}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${CONFIRM_TTL_S}${secureSuffix(url)}`;
}

export function clearConfirmCookieHeader(url: string): string {
  return `${CONFIRM_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix(url)}`;
}

/** Read one cookie from a request header. No dependency for four lines. */
export function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

/** Escape for HTML text and attribute contexts. The email is user-supplied. */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * NAMING THE ACCOUNT IS HALF THE FIX.
 *
 * Signing in is otherwise indistinguishable from being signed in as someone
 * else, and the rest of the app reads its displayed address from localStorage —
 * so a wrong account shows the right email everywhere. This sentence is the one
 * place a mismatch can be seen.
 */
export function confirmPage(email: string, linkToken: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in — Draft Genie</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; padding: 24px; }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; }
  strong { overflow-wrap: anywhere; }
  button { font: inherit; font-weight: 600; padding: .7rem 1.4rem; border: 0;
           border-radius: 8px; background: #1c6b3c; color: #fff; cursor: pointer; }
  .muted { font-size: .875rem; opacity: .7; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>Sign in to Draft Genie</h1>
  <p>You're about to sign in as <strong>${esc(email)}</strong>.</p>
  <form method="POST" action="/api/auth/magic">
    <input type="hidden" name="token" value="${esc(linkToken)}">
    <input type="hidden" name="confirm" value="${esc(nonce)}">
    <button type="submit">Continue as ${esc(email)}</button>
  </form>
  <p class="muted">If that isn't your address, close this page — someone else's
  sign-in link was opened in your browser.</p>
</main>
</body>
</html>`;
}
