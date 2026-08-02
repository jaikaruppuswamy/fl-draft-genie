# Draft Genie

A live-draft assistant for ESPN fantasy football. Draft Genie connects to your
league's live online draft, streams picks in real time, and — when you're on
the clock — recommends the right player to pick, scored in your league's own
scoring settings and powered by a proprietary rule set (value-based drafting,
team offensive potential, strength of schedule, bye weeks, O-line rankings,
and your preferred-player list).

Runs as a responsive web app for iPad and desktop. Works with any ESPN league
via a league setup page (no hardcoded leagues).

## Status

**Feature 001 (league onboarding) implemented and deployed** to
**https://draft.neelamjai.com** (Cloudflare Workers + D1) — passwordless email
sign-in, encrypted ESPN cookie storage, multi-league connect with settings
sync, and the pre-draft auto-sync cron. 68 tests green, all 46 tasks
complete, live-validated with real leagues (see
specs/001-league-onboarding/quickstart-results.md). Sign-in emails are
delivered via Cloudflare Email Service. Styled with the "Organic" design
system from Claude Design. Next up: 002-projections-pipeline.

This repo is driven by [Spec Kit](https://github.com/github/spec-kit):

- [ROADMAP.md](ROADMAP.md) — the project broken into 8 feature-sized spec cycles
- [.specify/memory/constitution.md](.specify/memory/constitution.md) — project principles

## Running locally

```bash
npm install
npm run migrate:local
cp .dev.vars.example .dev.vars   # fill in real values (see wrangler.jsonc comments)
npm run build                    # build the SPA once
npm run dev                      # Worker + SPA at http://localhost:8787
```

Sign-in codes print to the wrangler console in dev (`EMAIL_PROVIDER=console`).
See [specs/001-league-onboarding/quickstart.md](specs/001-league-onboarding/quickstart.md)
for the full validation script. `npm test` runs the suite (ESPN stubbed by fixtures).

## Workflow

Pick the next feature from ROADMAP.md, then in Claude Code:

1. `/speckit-specify <feature summary from ROADMAP.md>`
2. `/speckit-clarify` — debate the feature's open questions
3. `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`
