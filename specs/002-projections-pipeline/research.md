# Research: Projections Pipeline (002)

Resolves the plan's unknowns, including ROADMAP 002's deferred question:
*which ESPN views expose stat-line-level projections vs only pre-scored
points*. Format per decision: **Decision / Rationale / Alternatives**.

## 1. ESPN projection source & views

**Decision**: Fetch the player universe + season projections from ESPN's
fantasy v3 **`kona_player_info`** view against the season's *default league*
endpoint:

```
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leaguedefaults/3?view=kona_player_info
X-Fantasy-Filter: {"players":{"limit":1500,"sortDraftRanks":{"sortPriority":100,"sortAsc":true,"value":"PPR"},"filterStatsForSourceIds":{"value":[1]}}}
```

Each returned player carries `stats[]` entries keyed by
`statSourceId=1` (projection) + `statSplitTypeId=0` (season) whose `stats`
map is the **raw stat line** (`statId → projected amount`) — exactly what
FR-004 requires; `appliedTotal` (pre-scored PPR points) is ignored except as
a sanity cross-check. The same objects carry `player.ownership.
averageDraftPosition` (ADP), `draftRanksByRankType` (overall rank),
`defaultPositionId`, `eligibleSlots`, `proTeamId`, `injuryStatus`, and
`active`. These are **public, unauthenticated** endpoints — the global
refresh sends no cookies (important: the cron has no user context, and
constitution security wants credentials nowhere near global jobs).

Bye weeks come from the pro-team metadata view:

```
GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}?view=proTeamSchedules_wl
```

whose `settings.proTeams[]` includes `byeWeek` per NFL team.

**Rationale**: `kona_player_info` is the view ESPN's own draft tools use and
the only documented-in-the-wild view exposing per-category projected stat
lines; `leaguedefaults/3` avoids touching any real league. Endpoint shapes
are verified against the live season during implementation (fixtures
re-recorded per the established 001 practice) — ESPN drifts between seasons,
so the base URL and filter live in one module (`espnSource.ts`).

**Alternatives considered**: `players_wl` view (universe only, no stat
lines); per-league `kona_player_info` (needs credentials, per-league
duplication, violates FR-007); third-party projection APIs (out per the
ESPN-only clarified assumption); scraping (fragile).

## 2. Storage model & atomic refresh

**Decision**: Four tables (see data-model.md): `pro_teams`, `players`
(current-state upserts), `projection_sets` (one row per refresh with
`status: building → complete`), `player_projections` (immutable rows keyed
by set). A refresh writes everything under a new `building` set, then flips
it to `complete` as the last statement; the **serving set** is always the
newest `complete` set. Failed refreshes leave a dead `building` row (swept
opportunistically) and the prior serving set untouched (FR-017). All
`complete` sets for the current season are retained (FR-018/clarification);
prior-season sets are pruned by the scheduled job.

**Rationale**: Status-flip gives all-or-nothing semantics without
transactions spanning thousands of rows; per-set immutability makes trend
queries trivial later.

**Alternatives**: In-place upserts (partial-update exposure on failure —
violates FR-017); KV blob per refresh (no queryability for trends);
delete-then-insert serving copy (a crash mid-cycle leaves nothing serving).

## 3. Where league-currency points are computed

**Decision**: At read time, in the Worker: board requests load the serving
set's projections (~1,100 rows) plus the league's scoring map (001 snapshot)
and compute points + positional rank per request. No materialized per-league
cache.

**Rationale**: ~1,100 × ~20 multiply-adds is sub-millisecond CPU; read-time
compute makes FR-010 (league re-sync reflects instantly) free and keeps
zero cache-invalidation machinery (VIII). Revisit only if SC-001 misses.

**Alternatives**: Per-league cached boards in D1/KV (invalidation on two
axes — projection refresh and league re-sync — for no measured need);
client-side scoring (ships the full stat matrix to the browser; heavier
payload and duplicates scoring logic).

## 4. Refresh scheduling & rate limiting

**Decision**: Extend the existing 5-minute cron (`scheduled` handler): after
the pre-draft league scan, a freshness check runs — refresh if the serving
set is older than **24 h during Aug 1–Sep 30**, older than **7 d otherwise**,
or if any league just entered its pre-draft window and the serving set
predates that window's opening (**draft-day top-up**, SC-007). On-demand
refresh (`POST /api/projections/refresh`) is allowed at most **once per
15 minutes globally** (429 `rate_limited` otherwise) and is asynchronous-
completing within the request (Workers time budget fits a <60 s cycle).

**Rationale**: One cron, one policy module (`freshness.ts`), all constants
in code (constitution IV spirit: cadence is not user-configurable). The
15-minute floor protects ESPN while keeping "I want fresh numbers now"
usable on draft morning.

**Alternatives**: Separate cron expression for daily refresh (a second
schedule to reason about; the 5-min tick already provides the clock); Queues
(nothing to queue at this volume).

## 5. Positional rank & board shape

**Decision**: The board endpoint returns the full draftable board in one
response (~600 projected players + unprojected tail, trimmed fields);
position filtering and name search happen client-side. Positional rank =
1-based rank of projected points within the player's primary position,
computed server-side alongside points.

**Rationale**: One payload (~80 KB gzipped) beats chatty filtered queries on
draft-prep UX (instant filter/search); rank must be server-side because it
depends on the full population.

**Alternatives**: Server-side filter/search params (round-trips per
keystroke); paginated board (drafters scan and search — pagination fights
the use case).

## 6. Stat & position vocabulary

**Decision**: Reuse and extend 001's `STAT_LABELS` (espn/parsers.ts) as the
single stat-id→label map shared by scoring rules and projection detail;
positions derive from `defaultPositionId` (1 QB, 2 RB, 3 WR, 4 TE, 5 K,
16 D/ST) and `eligibleSlots` for multi-eligibility. Unknown stat ids stay
lossless as `Stat #N` (established 001 convention).

**Rationale**: One vocabulary prevents drift between "what the league
scores" and "what the projection projects" — the exact join FR-014's detail
view performs.

## 7. Testing strategy

**Decision**: Sanitized fixture `kona-players.json` (~25 players covering
QB/RB/WR/TE/K/DST, a multi-position player, an unprojected rookie, and a
player with an uncovered-category stat) + `proteams.json`. Unit: scoring
oracles hand-computed for PPR/half/standard leagues (SC-002); positional
rank ties; freshness policy with fake clocks (Aug vs Oct vs draft-day).
Contract: board shape/ordering, detail sums, refresh rate-limit 429, status
endpoint. Integration: full ingest-from-fixture → board → detail flow;
failed-ingest leaves prior set serving.

**Rationale**: Mirrors 001's proven fixture pattern; scoring oracles are the
SC-002 acceptance test executed continuously.
