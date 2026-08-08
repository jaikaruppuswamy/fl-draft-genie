# Contract: Automated Checks

**Feature**: 009-deployment-ops | **Phase 1**

What runs on every change, what blocks a merge, and how to get past it when a
draft is live.

---

## 1. The job

One workflow, one job, **zero secrets**. Triggered on `push` (no branch filter)
and `pull_request` — never `pull_request_target`.

| Step | Asserts |
|---|---|
| `npm ci` | the lockfile installs |
| `npm run build` | the vite build `npm run deploy` depends on still works |
| `npm run typecheck` | **all three** tsconfig projects — root, tap, web |
| `npm run lint` | eslint |
| `npm test` | build:tap → 4 vitest projects → privacy sweep |
| `git diff --exit-code web/public/draft-tap.user.js` | the committed userscript matches its source |

The last step matters because the bundle is committed and asserted against by
`tests/tap/passivity.test.ts` and `tests/tap/vocabulary.test.ts`. `npm test` now
rebuilds it first (018), so a drift between source and artifact shows up as a
dirty tree rather than as tests passing against a stale file.

## 2. Zero secrets is a verified property, not an aspiration

The full chain was run on a pristine checkout with `.dev.vars` deleted, `HOME`
pointed at an empty directory (so no `~/.wrangler` OAuth token) and no
`CLOUDFLARE_*` variables. It passes.

- `SESSION_SECRET` and `CREDENTIAL_KEY` in tests are test-only base64 literals in
  the vitest configs.
- `@cloudflare/vitest-pool-workers` runs entirely in local Miniflare/workerd; the
  `database_id` in `wrangler.jsonc` is never dialled.
- Migrations are read from disk by `readD1Migrations()` and applied per test
  file. No `wrangler d1 migrations apply` in CI.

Because the job needs no secrets, a fork PR cannot exfiltrate any: GitHub
withholds every secret from fork-triggered `pull_request` runs. **Deploy stays
out of this workflow.** If it is ever added, it goes in a separate
`push: branches: [main]` workflow holding its token in a GitHub Environment,
which a fork structurally cannot trigger.

## 3. Prerequisites — Phase 0, before the gate is turned on

**The privacy sweep is not currently safe to run in public.** Two defects:

1. **It violates FR-011.** The GUID branch reports
   `non-placeholder GUID ${g.slice(0, 8)}…` — 32 bits of a real SWID, into what
   would become a public CI log. Report a count, as the member-name branch
   already does.
2. **Its `espn_s2` check misses the real shapes.** The regex requires an
   *unquoted* key followed by a quoted value, so JSON `"espn_s2": "AEB…"` — the
   shape every captured ESPN fixture uses — and a raw cookie string both pass.

**And `npm test` fails on a pristine clone.** `wrangler.jsonc` declares
`assets.directory: "web/dist"`, which is gitignored; the pool validates it while
loading the config. Fix at the source so a new contributor is not the one who
finds it.

Turning on a gate that leaks part of a secret, in the name of preventing leaks,
would be this feature failing at its own thesis.

## 4. The database-id rule

`specs/` is a swept root and the sweep cannot tell a D1 database id from a SWID —
both are bare UUIDs, and `isFabricated()` admits only the fixed test SWID, the
derived pattern, and repeated-character groups.

**Every document under a swept root refers to the database by name
(`draft-genie`) and never by id.** `wrangler.jsonc` keeps its id and is
unaffected, because repo root is not swept. A regression test asserts the runbook
stays clean, so this recurs the next time a spec quotes configuration.

## 5. What blocks a merge

Branch protection on `main`:

- the single `check` job must pass
- **require branches to be up to date before merging** — US2 AS-4: a green tick
  on stale results is worse than none
- **do not allow bypassing the above** — otherwise FR-010 is advisory

## 6. Break-glass

**Principle V requires a documented way to land a fix mid-draft.** Branch
protection that cannot be lifted is a draft-day hazard, and improvising it at
9:45 PM is how mistakes get made.

The procedure lives in `docs/runbook.md` and states: who can lift protection,
what to do instead first (deploy from the existing local `npm run deploy`, which
needs no CI), and the requirement to restore protection and open a
reconstructing PR afterwards.

The local deploy path is the real answer in most cases — it is how every deploy
in this project has happened to date, and it does not touch GitHub at all.
