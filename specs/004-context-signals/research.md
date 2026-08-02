# Research: Context Signals (004)

## 1. NFL schedule source

**Decision**: Parse the schedule from the `proTeamSchedules_wl` view Draft
Genie already fetches for byes (002): each `settings.proTeams[]` entry
carries `proGamesByScoringPeriod` — a map of week → game(s) with
`homeProTeamId`/`awayProTeamId`. Extend the existing parser to also emit
(team, week, opponent) triples; verify the field shape against the live
endpoint at implementation (established practice).

**Rationale**: Zero new sources (ratified derive-don't-fetch); one fetch
already on the refresh path.

**Alternatives**: separate ESPN scoreboard/schedule APIs (new surface for
data we already receive); manual schedule file (stale-prone, 272 games).

## 2. Reference scoring for cross-team strength

**Decision**: A fixed in-code reference scoring map — standard fantasy
values (pass 0.04/yd, 4/TD, −2 INT; rush/rec 0.1/yd, 6/TD; 0.5 PPR;
−2 fumble) for offense, and a conventional D/ST map (sacks 1, INT/fumble 2,
TDs 6, safety 2, block 2) for defensive strength. Signals score every
projected stat line with these maps, aggregate per team, then normalize.

**Rationale**: Signals are global (league-agnostic by spec); ranks need one
consistent yardstick. The choice of yardstick barely moves *ranks* (they're
ordinal), and it never touches league-currency point displays (constitution
III guarded — reference scoring exists only inside signal computation).

**Alternatives**: per-league signal computation (32× the work for near-
identical ranks, and signals stop being global); ESPN's pre-scored
`appliedTotal` (dropped at ingest; would re-couple us to ESPN's PPR frame).

## 3. Signal formulas

**Decision**:
- **Offense**: Σ reference-scored stat lines of the team's projected
  QB/RB/WR/TE players (K and D/ST excluded). Raw = points; rank 1 = highest.
- **Defensive strength** (SoS ingredient, not itself served): the team's
  D/ST reference-scored projection total.
- **SoS**: for team T, weighted mean of opponents' defensive strength over
  scheduled weeks (bye omitted), weight 2 for weeks 15–17, else 1
  (ratified). Raw = weighted mean; **rank 1 = easiest** (lowest opponent
  strength).
- **Normalization**: min-max to 0–100 across the 32 teams, oriented so
  **100 is always the favorable end** (best offense, easiest schedule, best
  O-line) — one orientation rule for every consumer (006).
- **Ties**: shared better rank, stable order by team id.
- **Labels**: rank ≤ 5 → "Top-5 …", ≤ 10 → "Top-10 …", ≥ 28 → "Bottom-5 …",
  ≥ 23 → "Bottom-10 …", else "Mid-pack" — thresholds in code.

## 4. Storage & atomicity

**Decision**: Single `signal_entries` table, per-kind replace as one
transactional D1 batch (delete kind + chunked inserts) — the proven
`tier_entries` pattern. Provenance + computed_at columns on every row;
"latest complete" is simply "what's there", because the batch is atomic.

**Alternatives**: set/rows pair like projections (versioned history — no
consumer needs signal history; YAGNI), KV blob (no joins).

## 5. Curated O-line file

**Decision**: `src/signals/data/oline-2026.json` — `{kind, season, source:
"PFF preseason OL rankings", source_url, seeded_at, entries: [{team_abbrev,
rank}]}`. Loader (`curated.ts`) validates exactly 32 entries and that every
abbrev resolves against `pro_teams`; on failure it logs loudly and keeps the
previous stored signal (FR-008/SC-005). Seeding: transcribe PFF's current
preseason rankings at implementation (web lookup); if the current article
can't be reached, ship the file marked `"provisional": true` for the owner
to review — the provenance field never lies.

## 6. Recompute trigger & serving

**Decision**: `computeSignals(env, now)` runs at the same two sites as tier
ingestion (scheduled maintenance after a projection refresh, and the
on-demand refresh endpoint), plus when the signals table is empty. Never
throws. The detail endpoint reads a per-team signal map in one query and
attaches `signals` to the response (contract addition, additive).

**Alternatives**: computing lazily at read time (recomputes 32-team
aggregation per detail open — cheap but wasteful, and loses the
computed-at-lockstep property SC-004 requires).
