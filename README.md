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

Requirements phase. This repo is driven by [Spec Kit](https://github.com/github/spec-kit):

- [ROADMAP.md](ROADMAP.md) — the project broken into 8 feature-sized spec cycles
- [.specify/memory/constitution.md](.specify/memory/constitution.md) — project principles

## Workflow

Pick the next feature from ROADMAP.md, then in Claude Code:

1. `/speckit-specify <feature summary from ROADMAP.md>`
2. `/speckit-clarify` — debate the feature's open questions
3. `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`
