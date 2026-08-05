# Draft Genie — Feature Roadmap

A live-draft assistant for ESPN fantasy football: it connects to a league's live
online draft, streams picks in real time, and recommends the right player when
you're on the clock, using a proprietary rule set (value-based drafting, team
offensive potential, strength of schedule, bye weeks, O-line ranking, and a
user-maintained preferred-player list).

Feature numbers match the spec directories under `specs/` (renumbered
2026-08-02 after inserting 003-board-refinements). Each feature is one Spec
Kit cycle: `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` →
`/speckit-tasks` → `/speckit-implement`. Dependency order:

```
001 league-onboarding ✅
 ├─→ 002 projections-pipeline ✅ ─→ 003 board-refinements ✅
 ├─→ 004 context-signals ✅ ────────┬─→ 006 recommendation-engine ✅ ┐
 └─→ 010 draft-tap ✅ ─→ 005 draft-monitor ✅ ─┘                  ├─→ 007 draft-room-ui
                                   └──────────────────────────────┴─→ 008 draft-replay-lab
009 deployment-ops (exercised continuously since 001; hardening at the end)
```

**010 is numbered after 009 but sequenced before 005** — inserting it as 006
would have renumbered four downstream features and every cross-reference in
their shipped specs. Directory numbers are identifiers, not execution order;
this diagram is the order.

---

## 001 — league-onboarding ✅ SHIPPED (2026-08-02)

Account + league setup: passwordless email sign-in, encrypted ESPN cookie
storage (`espn_s2`/`SWID` with in-app instructions), multi-league connect
with settings sync (scoring rules, roster slots, draft type/time), dashboard,
and automatic repeated re-sync in the ~75-minute pre-draft window (captures
the late-published draft order). Deployed to https://draft.neelamjai.com and
live-validated with the owner's three leagues.

**Ratified decisions**: Cloudflare hosting (Workers + D1; Fly.io off the
table); WebSockets for future real-time delivery; multi-user shared service
with passwordless email sign-in (no passwords stored); every league
connection requires ESPN credentials and a team identified as the user's (no
public/observer modes); exactly one ESPN cookie pair per account; sign-in
email via Cloudflare Email Service (`neelamjai.com` onboarded; Resend kept as
a swappable adapter).

## 002 — projections-pipeline ✅ SHIPPED (2026-08-02)

Global player universe + ESPN season projections (raw per-category stat lines
from the public `kona_player_info` view — no credentials in the global
refresh), re-scored per league at read time from 001's lossless scoring maps.
Per-league **Player board** (projected points, positional rank, ADP, byes,
filter/search) and a per-player projection-detail breakdown (stat × value →
points). Immutable projection sets with atomic publish; refresh daily in
Aug–Sep / weekly otherwise, plus a draft-day top-up and rate-limited
on-demand refresh.

**Ratified decisions**: ESPN as sole projection source behind one module;
season-long projections only; every season's projection sets retained as
history for future trend signals; positional ranks on the board; draft-day
top-up guarantees same-morning projections.

## 003 — board-refinements ✅ SHIPPED (2026-08-02)

Owner-requested refinements after production use of 002: the projection
detail lists only covered categories (uncovered ones collapse into a count
note); player tiers from Boris Chen's public feeds (matched to each league's
scoring format with normalized names, tier groupings under single-position
filters, graceful degradation when the source is down); centered board
column headers.

## 004 — context-signals

**Summary**: The non-projection signals the secret sauce needs, one ingestion
job per signal: team offensive potential for the season (e.g. projected team
totals), strength of schedule per player/position, bye weeks, and offensive
line rankings. Each signal is normalized (e.g. 0–100 or z-score) and versioned
so the engine can consume them uniformly and new signals can be added later
without touching the engine's interface.

**Open questions**: source per signal (derivable from ESPN data vs. an external
free source vs. manually seeded table updated once per preseason — simplest
wins per Principle VIII); whether O-line ranking starts as a hand-maintained
table; how SoS is computed (full season vs. fantasy-playoff weeks weighted);
how much 003's Boris Chen tiers (already an expert-consensus signal) trim
this feature's scope.

## 005 — draft-monitor

**Summary**: The real-time nerve center. For a connected league with a live
draft scheduled, Draft Genie opens a draft session that: detects when the draft
room opens, pulls the draft order as soon as ESPN publishes it (~1 hour before
start), polls ESPN for picks during the draft, maintains authoritative draft
state (every pick, every roster, who's on the clock, picks-until-my-turn), can
rebuild state from scratch after a crash or reload, and pushes updates to
connected clients in real time. Emits the events the engine and UI consume:
`pick_made`, `on_deck`, `on_the_clock`, `draft_complete`.

> ⛔ **BLOCKED (2026-08-03) — Gate 0 failed, premise disproved.** ESPN writes
> draft picks to its league database **once, when the draft completes**: 207
> samples across ~30 real picks showed `mDraftDetail` frozen, and `mRoster` is
> confirmed no better (all DRAFT transactions in a finished draft share one
> `proposedDate` equal to `completeDate`). **No ESPN read API can see a draft in
> progress.** Live picks now arrive by ingest from a browser tap — see
> **010-draft-tap**, which lands first. The two-tier poll cadence ratified
> 2026-08-02 is withdrawn. Everything server-side in 005 (session, reconciler,
> events, delivery, archive) stands; `plan.md`/`tasks.md` need regeneration.

**Ratified decisions (2026-08-05, round 4 — after 010 shipped and fed two real
drafts)**: SC-001's tiered latency promise is replaced by a **flat push budget —
p95 ≤ 2 s, 100% ≤ 10 s** from the tap's `observed_at` (measured p95 was
0.223 s across a 72-pick draft); ingest **acks on the durable log write** and
the live session is fed *from* that log, never inside the ingest request;
liveness comes from a **tap heartbeat**, not pick silence, because measured
inter-pick gaps ranged from ~1 s under autodraft to 90 s+ between human picks;
a session is **armed lazily by the first tap frame** (heartbeat included) and
fetches pre-draft data then, so it exists before the first pick; and
recommendations are withheld for `incompatible`/`version-rejected` but **not**
for `buffering`/`draft-end-unknown`.

> ✅ **The one obligation this put back on 010 is DISCHARGED (2026-08-05).** Tap
> **0.1.6** emits a periodic heartbeat carrying a `hidden` flag, and
> `/api/tap/status` validates, privacy-screens and records it (010 FR-015a,
> T055). The flag is load-bearing: a background tab's timers throttle to
> ~1/minute, so 005 applies a 45 s lapse when visible and 150 s when hidden
> rather than declaring a healthy backgrounded tap dead.

**Ratified decisions (2026-08-03, round 3)**: picks arrive by **ingest from a
browser tap**, not polling; the tap is its own feature (`010-draft-tap`) and
ships **before** 005 resumes, so the reconciler is written against real frames;
mid-draft rebuild replays a **persisted frame log**, reconciled against the full
pick ledger ESPN sends on draft-room load; with the room open and no frames
arriving, the session reports **not receiving picks** and withholds
recommendations rather than showing a stale board as current.

**Ratified decisions (2026-08-02, `/speckit-clarify`)**: ~~live poll cadence is
two-tier — 10 s baseline, 3 s once the user is within 3 picks of their turn~~
*(withdrawn — no live poll source exists)*;
a live session stays alive for the whole draft whether or not a client is
connected, polling at 30 s while unattended; snake drafts only this season,
with the state model and event contract shaped so auction can be added later
without reworking consumers (no auction implementation); the feature ships a
deliberately throwaway per-league diagnostic page — 007 owns the designed
draft room; completed drafts are retained indefinitely as season history,
replay-sufficient for 008. Autodraft and keeper handling resolved in the spec's
edge cases (autodraft picks are ordinary picks; keepers are unavailable from
pick one).

**Open questions**: transport details for the ratified WebSocket push (Durable
Object per draft room per 001's plan notes) — settled in `/speckit-plan`.

## 006 — recommendation-engine ✅ SHIPPED (2026-08-05)

**Summary**: The secret sauce. A pure, deterministic, offline-testable module:
input = league context (scoring, roster needs), draft state (available players,
my roster, current round/pick), player board (002) and signals (004), plus the
user's preferred list; output = a full ranked board whose shortlist head carries
an explanation per player (Principle VII). Core is value-based drafting
(replacement-level value
by position, round-value awareness so we know what a player "should" cost),
layered with rule adjustments: team offensive potential, SoS, bye-week
conflicts, O-line ranking, positional scarcity/run detection, and a bounded
boost for preferred players ("can go a bit higher than projected value").
Rules are code, not config (Principle IV).

**Ratified in clarify (2026-08-05)** — five decisions, now binding on the spec:

- **Output is the full ranked board**, not a shortlist alone: every available
  player is ordered, with a designated shortlist head carrying the full
  explanations and value/rank for the rest. 007 and 008 build against the whole
  ordering. (Resolves "full board or only a shortlist".)
- **006 owns the preferred-player list** — storage, a read/write API, and a plain
  standalone page to enter it before draft day. The draft room stays 007's. No
  other feature provided one, and without it the preference rule could never fire
  on a real draft.
- **The engine looks forward, not only back.** It estimates whether each player
  survives to the owner's next turn, from ADP and the count of intervening picks.
  No model of what specific opponents will do — derived from data already on
  hand, so determinism holds.
- **Mandatory slots (K/DST) are enforced only when forced.** While remaining
  picks exceed unfilled mandatory slots, rank by value and warn; once they are
  equal, every pick is forced and the shortlist head is mandated positions only.
  A mandated position is never weighted up before that point.
- **Adjustments combine additively in the league's own value currency**, each
  carrying its own signed magnitude, and they must reconcile to the difference
  between raw and final value. The preferred boost is one of them, capped
  relative to the league's value spread rather than as a flat point count, and
  distinctly marked with the exact value it contributed so the display can badge
  the player and show what the preference was worth. (Resolves "how rule
  adjustments combine" and the *unit* of the preferred bound.)

**Numbers ratified in `/speckit-plan` and shipped (2026-08-05)** — all in
`src/engine/constants.ts`, which exists so this tuning session has ONE file to
open. Every one is expressed as a fraction of `ROUND_VALUE` (the value given up
by waiting a round, measured on the current board), so they mean the same thing
in a 10-team standard league and a 14-team PPR one:

| Constant | Value | Note |
|---|---|---|
| `WEIGHT.offense` | 0.30 | broadest signal; every offensive position incl. K |
| `WEIGHT.sos` | 0.20 | real but noisy this far from the season |
| `WEIGHT.oline` | 0.25 | curated (PFF); RB and QB only |
| `WEIGHT.bye` | 0.35 | concrete rather than forecast, so the largest |
| `WEIGHT.scarcity` | 0.30 | observed from the draft itself |
| `PREFERRED_CAP` | 1.0 | "about one round early", and no further |
| `ADP_COMBINED_CAP` | 0.75 | ceiling on `slot_value` + `survival` together |
| `SHORTLIST_SIZE` | 5 | how many get a full explanation |
| `FLOOR_DENSITY_RATIO` | 10 | ADP-floor detection; provably not load-bearing |

Their plausible maximum sum is about one round, which is the intended ceiling
for the whole rule layer: rules break ties and move a player a round, they never
overturn the value ranking. **These are first estimates**, chosen for the right
order of magnitude and the right RELATIVE ordering. Scoring them against
outcomes needs 008's replay lab.

**Still open — its own tuning session**: whether the replacement-level baseline
should be the last starter (as shipped) or a different definition per league
shape, and every magnitude above once there is evidence to move it with.

## 007 — draft-room-ui

**Binding obligation inherited from 006 (FR-015, contracts/api.md §1a)**: the
draft room MUST request `GET /api/leagues/:id/recommendations` on 005's
**`on_deck`** event, never on `on_the_clock`. 005 emits `on_deck` a full turn
ahead; requesting on the clock starts the computation when the timer does, which
is what Constitution V forbids. **SC-005 is measured against this call site**, so
it is 007 that makes it true or false — 006 only makes it possible. Recorded here
because during 005 `writeArchive` was built, tested and never called, and
production showed zero archives after a completed draft.


**Ratified design (2026-08-02)**: The visual design is set — Claude Design
project `3fc40045-01d4-49a7-af1e-58a2fd7f74cd`, screen "Draft Genie Draft
Screen.dc.html", built on the "Organic" design system (cream/sand ground,
terracotta + sage accents, Caprasimo/Figtree, pill controls, tonal ramps).
The system's tokens style the whole app (`web/src/styles.css`), and a
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

## 008 — draft-replay-lab

**Summary**: The test harness that makes the secret sauce trustworthy. Record
every live draft the monitor observes; import past ESPN drafts; replay any
recorded draft against the current engine to see what Draft Genie would have
recommended at each of the user's picks; run simulated drafts (ADP-driven
opponents) to sanity-check rule changes before draft day. This is how rule
tuning sessions (Principle IV) validate their changes.

**Open questions**: simulation opponent model (pure ADP with noise?); metrics
for "the engine did well" (projected points of resulting roster vs. actuals);
CLI or UI.

## 010 — draft-tap ✅ SHIPPED (2026-08-05)

**Summary**: The browser userscript that makes live drafting possible at all.
Gate 0 (2026-08-03) proved ESPN's read API cannot see a draft in progress; the
picks exist only in the realtime channel the user's own draft-room tab is
already receiving. This feature ships a userscript that, injected at
`document_start` into the ESPN draft-room page, passively mirrors those
messages to a Worker ingest endpoint.

**Strictly passive** (Constitution VI): it opens no connection to ESPN, never
sends a `JOIN` (which would register a participant and could evict the user's
own session), has no send path at all, and only observes bytes the browser is
already receiving. Confirmed working by multiple independent projects at
sub-second latency.

**Deliverables**: the userscript + install flow; a per-user revocable ingest
credential distinct from the ESPN cookie pair; the documented frame contract
005 consumes; and a **captured frame corpus** from a real draft, which is what
lets 005's reconciler be built and tested without a live draft.

**Ratified decisions (2026-08-03, `/speckit-clarify`)**: ships as a
**userscript** under a third-party script manager — chosen for the update path,
since an undocumented protocol can break on draft day and a store-reviewed
extension cannot be fixed in time; **desktop Chrome only**, making "no live
monitoring when drafting from an iPad, phone or the ESPN mobile app" a
permanent documented limitation rather than a gap to close later; and relayed
messages carry **numeric identifiers only** — names, member identifiers and free
text are discarded *before* transmission, so leaguemates' data never crosses the
boundary and recorded fixtures are clean by construction.

**Open questions**: **the `SELECTED` frame's field 1 is unresolved** — one
public protocol doc and its own code disagree on whether it is `teamId` or the
pick number, and round-1 data cannot disambiguate them, so the capture must
settle it before any reconciler depends on it; and how the pairing credential
reaches the browser, given the tap runs on ESPN's origin and cannot read the
app's session (plan-level).

**Governance**: introduces a browser artifact the constitution's Technical
Constraints do not contemplate ("responsive web app … No native app").
Requires an explicit `/speckit-constitution` amendment before implementation.

## 009 — deployment-ops

**Summary**: Production hardening on Cloudflare: environments, secret
management, scheduled jobs, logging and alerting (especially "draft session
died mid-draft"), backups, and a draft-day runbook. Much is already exercised
continuously (deployed since 001: custom domain, D1 migrations, secrets,
cron, Email Service); this feature closes the remaining gaps at the end.

---

### Notes

- ESPN access pattern (001/002/005): ESPN's fantasy API v3
  (`lm-api-reads.fantasy.espn.com`) — cookie-authenticated for private league
  data, public/unauthenticated for the global projection views; draft picks
  via the `mDraftDetail` view. No public push API — polling is the baseline
  assumption. ESPN changes endpoints between seasons; every external source
  lives behind a single module.
- Priority order for a usable draft-day v1: ~~001 → 002 → 003~~ (shipped) →
  **005** → 006 (VBD core only) → 007, then 004 signals and 008 replay lab
  deepen the sauce, 009 wraps.
