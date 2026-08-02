# Draft Genie — guidance for Claude Code

This project is spec-driven via Spec Kit. Before doing anything else, read:

1. `.specify/memory/constitution.md` — binding principles (spec-first,
   any-league design, league-currency scoring, rules-are-code, draft-day
   resilience, read-only vs ESPN, explainable recommendations, simplicity).
2. `ROADMAP.md` — the feature breakdown (001–009, ids match specs/ dirs), dependency order, and each
   feature's open questions to debate during clarify.

## Rules of engagement

- No implementation code without an approved spec and plan for that feature
  (`/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks`
  → `/speckit-implement`). Feature specs live in `specs/NNN-name/`.
- One feature per branch. Keep features small; if a spec balloons, split it and
  update ROADMAP.md.
- When a spec session resolves one of ROADMAP.md's open questions or ratifies a
  decision (e.g. the hosting platform in 001), record the decision back into
  ROADMAP.md.
- ESPN cookies (`espn_s2`, `SWID`) are secrets — never log them, never commit
  them, never put them in URLs or client-visible code.
- The recommendation rule set is intentionally NOT user-configurable. Do not
  add settings/knobs for it, even if it seems helpful.
