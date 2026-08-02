# Draft Genie — Feature Roadmap

A live-draft assistant for ESPN fantasy football: it connects to a league's live
online draft, streams picks in real time, and recommends the right player when
you're on the clock, using a proprietary rule set (value-based drafting, team
offensive potential, strength of schedule, bye weeks, O-line ranking, and a
user-maintained preferred-player list).

Each feature below is one Spec Kit cycle. Start a feature by running
`/speckit-specify` with the feature's summary paragraph, debate the open
questions during `/speckit-clarify`, then `/speckit-plan` → `/speckit-tasks` →
`/speckit-implement`. Work them roughly in order — the dependency graph is:

```
001 league-onboarding
 ├─→ 002 projections-pipeline ─┐
 ├─→ 003 context-signals ──────┼─→ 005 recommendation-engine ─┐
 └─→ 004 draft-monitor ────────┘                              ├─→ 006 draft-room-ui
                               └──────────────────────────────┴─→ 007 draft-replay-lab
008 deployment-ops (hosting decision made in 001's plan; hardening at the end)
```

---

## 001 — league-onboarding

**Summary**: Account + league setup. A user signs in to Draft Genie, connects
their ESPN account by pasting their `espn_s2` and `SWID` cookies (with in-app
instructions), and adds one or more leagues. The app validates each league,
pulls and stores its settings (scoring rules, roster slots, team count, draft
type and scheduled time), identifies which team belongs to the user, and shows
a league dashboard. Settings re-sync on demand and automatically shortly before
draft time (draft order is only published ~1 hour before the draft).

**Open questions — RESOLVED (2026-08-02, `/speckit-clarify`)**:
- App identity: multi-user shared service; passwordless email sign-in (magic
  link / one-time code), no passwords stored.
- Public leagues / observer mode: NOT supported — every connection requires
  ESPN credentials and a team identified as the user's.
- Re-sync: manual "sync now" + automatic repeated refresh every few minutes
  during the pre-draft window (from ~75 min before draft time until start).
- ESPN identities: exactly one cookie pair per account; multiple ESPN
  accounts → multiple Draft Genie accounts.

**Ratified decisions (2026-08-02, during 001 specify)**:
- **Hosting: Cloudflare** (Workers platform). Fly.io is off the table.
- **Real-time delivery: WebSockets** (server → client push for draft events).
- Stack details (Durable Objects for draft rooms, D1/KV for storage, etc.) are
  settled in 001's `/speckit-plan`.
- Spec status: `specs/001-league-onboarding/spec.md` drafted; defaults chosen
  there pending `/speckit-clarify` debate — multi-user shared service,
  passwordless email sign-in, one ESPN identity per account, public leagues
  connectable without cookies.

## 002 — projections-pipeline

**Summary**: The player universe and season projections. Pull the full NFL
player list and ESPN's season-long projections, convert projected stat lines
into points **per league** using that league's scoring settings (Principle III),
store ADP/rank data, and refresh on a schedule and on demand. Output: for any
connected league, a queryable board of every draftable player with projected
points, position, NFL team, and ADP.

**Open questions**: which ESPN views/endpoints provide stat-line-level
projections (needed to re-score per league) vs. only pre-scored points; how
often to refresh in draft season; what to do about rookies/missing projections.

## 003 — context-signals

**Summary**: The non-projection signals the secret sauce needs, one ingestion
job per signal: team offensive potential for the season (e.g. projected team
totals), strength of schedule per player/position, bye weeks, and offensive
line rankings. Each signal is normalized (e.g. 0–100 or z-score) and versioned
so the engine can consume them uniformly and new signals can be added later
without touching the engine's interface.

**Open questions**: source per signal (derivable from ESPN data vs. an external
free source vs. manually seeded table updated once per preseason — simplest
wins per Principle VIII); whether O-line ranking starts as a hand-maintained
table; how SoS is computed (full season vs. fantasy-playoff weeks weighted).

## 004 — draft-monitor

**Summary**: The real-time nerve center. For a connected league with a live
draft scheduled, Draft Genie opens a draft session that: detects when the draft
room opens, pulls the draft order as soon as ESPN publishes it (~1 hour before
start), polls ESPN for picks during the draft, maintains authoritative draft
state (every pick, every roster, who's on the clock, picks-until-my-turn), can
rebuild state from scratch after a crash or reload, and pushes updates to
connected clients in real time. Emits the events the engine and UI consume:
`pick_made`, `on_deck`, `on_the_clock`, `draft_complete`.

**Open questions**: poll cadence (and whether to tighten near the user's turn);
snake vs. auction vs. linear draft support in v1 (recommend snake-only first);
what "connected in real time" means concretely (WebSocket vs. SSE vs. client
polling our own API); autodraft/keeper edge cases.

## 005 — recommendation-engine

**Summary**: The secret sauce. A pure, deterministic, offline-testable module:
input = league context (scoring, roster needs), draft state (available players,
my roster, current round/pick), player board (002) and signals (003), plus the
user's preferred list; output = a ranked shortlist with an explanation per
player (Principle VII). Core is value-based drafting (replacement-level value
by position, round-value awareness so we know what a player "should" cost),
layered with rule adjustments: team offensive potential, SoS, bye-week
conflicts, O-line ranking, positional scarcity/run detection, and a bounded
boost for preferred players ("can go a bit higher than projected value").
Rules are code, not config (Principle IV).

**Open questions**: replacement-level baseline definition per league shape; how
rule adjustments combine (additive points vs. multipliers vs. tie-breakers);
size of the preferred-player boost bound; how roster-slot needs constrain
recommendations in late rounds (K/DST timing); whether the engine also produces
a full "best available" board or only a shortlist. The detailed rule tuning is
deliberately its own future spec session(s).

## 006 — draft-room-ui

**Ratified design (2026-08-02)**: The visual design is set — Claude Design
project `3fc40045-01d4-49a7-af1e-58a2fd7f74cd`, screen "Draft Genie Draft
Screen.dc.html", built on the "Organic" design system (cream/sand ground,
terracotta + sage accents, Caprasimo/Figtree, pill controls, tonal ramps).
The system's tokens now style the whole app (`web/src/styles.css`), and a
faithful mock-data port of the draft screen ships at `/design/draft`
(`web/src/pages/DraftBoard.tsx`) as the reference this feature must match
when it wires in real draft state.

**Summary**: The screen open on the iPad/laptop during the draft. Pre-draft:
league picker, preferred-player list management (search, add, rank), draft
countdown, draft-order display once known. Live: real-time pick feed, my
roster so far, picks-until-my-turn indicator, and — front and center when on
the clock (and pre-computed on deck, Principle V) — the recommendation card
with explanations and alternatives. Touch-friendly, readable at arm's length,
survives a page reload mid-draft.

**Open questions**: how much of the full draft board to show vs. focus mode;
audio/visual alert when the user is on the clock or on deck; whether preferred
lists are per-league or shared across leagues (recommend per-league).

## 007 — draft-replay-lab

**Summary**: The test harness that makes the secret sauce trustworthy. Record
every live draft the monitor observes; import past ESPN drafts; replay any
recorded draft against the current engine to see what Draft Genie would have
recommended at each of the user's picks; run simulated drafts (ADP-driven
opponents) to sanity-check rule changes before draft day. This is how rule
tuning sessions (Principle IV) validate their changes.

**Open questions**: simulation opponent model (pure ADP with noise?); metrics
for "the engine did well" (projected points of resulting roster vs. actuals);
CLI or UI.

## 008 — deployment-ops

**Summary**: Production hardening on the platform ratified in 001: environments,
secret management for ESPN cookies, scheduled jobs for data refresh, logging
and alerting (especially "draft session died mid-draft"), backups, and a
draft-day runbook. Small by design — most deployment reality is exercised
continuously from 001 onward.

---

### Notes

- ESPN access pattern (shared by 001/002/004): ESPN's fantasy API v3
  (`lm-api-reads.fantasy.espn.com`) with `espn_s2`/`SWID` cookies for private
  leagues; draft picks via the `mDraftDetail` view. No public push API —
  polling is the baseline assumption. Verify current endpoints during 001's
  plan phase; ESPN changes them between seasons.
- Priority order for a usable draft-day v1: 001 → 002 → 004 → 005 (VBD core
  only) → 006, then 003 signals and 007 replay lab deepen the sauce, 008 wraps.
