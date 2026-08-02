# Quickstart & Validation: League Onboarding (001)

How to run the feature locally and prove it satisfies the spec. Contracts:
[contracts/api.md](contracts/api.md); schema: [data-model.md](data-model.md).

## Prerequisites

- Node 20+, npm, wrangler (`npm i -g wrangler`) with a Cloudflare account
- A real ESPN fantasy football account in ≥ 1 league (for end-to-end checks)
- Your `espn_s2` and `SWID` cookies (the app's setup page shows retrieval
  steps; for testing, copy from browser dev tools on fantasy.espn.com)

## Setup

```bash
npm install
npx wrangler d1 create draft-genie          # once; put the id in wrangler.jsonc
npx wrangler d1 migrations apply draft-genie --local
```

Secrets (local: `.dev.vars`, git-ignored; production: `wrangler secret put`):

| Secret | Value |
|--------|-------|
| `SESSION_SECRET` | 32+ random bytes, base64 |
| `CREDENTIAL_KEY` | 32 bytes base64 (AES-256 key) |
| `RESEND_API_KEY` | only for production; dev uses the console email adapter |

Run: `npm run dev` (starts Vite + `wrangler dev`; app at the printed URL).
Dev email adapter prints sign-in codes to the wrangler console.

## Validation scenarios

Each maps to spec acceptance criteria; run in order.

1. **Sign in (US1/US4)** — enter your email → copy the 6-digit code from the
   dev console → verify. Expect the dashboard shell. Sign out; expect access
   gone. Sign in on a second browser; expect the same account (SC-007).
2. **Store credentials (FR-004..006)** — paste cookies *with* stray quotes/
   whitespace and SWID without braces; expect normalization and
   `status: working`. Expect only a masked SWID anywhere in the UI. Paste
   garbage; expect `espn_rejected` with actionable text and nothing stored
   (SC-006).
3. **Connect league (US1, SC-001/002)** — paste your league URL. Expect the
   league on the dashboard with your team auto-matched, and the settings
   page to match ESPN's league settings screen category-for-category
   (SC-002 check across ≥ 3 leagues with different scoring).
4. **Multi-league isolation (US2, SC-003)** — connect 2+ leagues; verify
   distinct settings per league; delete one; others intact.
5. **Failure modes (FR-012, edge cases)** — connect a bogus league id
   (`league_not_found`), the same league twice (`already_connected`), and a
   league you're not in (team-pick 409 → decline → no connection).
6. **Re-sync (US3)** — change a scoring value in a test league on ESPN,
   press "sync now", expect the new value + fresh timestamp. Stop network
   (dev: point ESPN base URL at a dead port) and sync; expect stale data
   kept with age label + warning (FR-020).
7. **Pre-draft window cron (FR-019, SC-004)** — set a mock league draft time
   ~70 min ahead (fixture league or real one pre-draft), then:

   ```bash
   curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
   ```

   Expect a sync pass over that league; once ESPN publishes the draft order,
   a scheduled pass lands it within one 5-min tick (SC-004).
8. **Secret hygiene (SC-005)** — run `npm test` (includes the no-secrets
   contract sweep), then manually grep `wrangler dev` output and browser
   network tab for your `espn_s2` value; expect zero hits post-entry.

## Test suite

```bash
npm test          # unit + contract + integration (ESPN stubbed by fixtures)
```

CI never calls live ESPN; scenarios 3/6/7 above are the manual live checks
before calling the feature done.
