# Phase 0 Research: Recommendation Engine

**Feature**: 006 | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md)

The spec deliberately deferred every number to this phase. What follows fixes
the *shape* of each rule and the *derivation* of each constant. Nothing here
introduces a setting; every quantity is either a module constant or derived
from the league's own data, per Constitution IV.

A theme runs through all of it: **wherever a magnitude was tempting to invent,
it is instead derived from the league.** A flat "+8 points for a preferred
player" would mean something different in a PPR league than a standard one and
would silently violate Constitution II and III. So the engine establishes one
self-scaling unit of value and expresses every adjustment in it.

---

## §1 — The value unit: one round's worth of value

**Decision**: Define `ROUND_VALUE` = the value a drafter gives up by waiting one
full round, measured on the *current available board*:

```text
ROUND_VALUE = value(available[0]) − value(available[teamCount])
```

with a fallback to `value(available[0]) − value(available[last])` when fewer
than `teamCount + 1` players remain, and `0` when fewer than two remain.

Every adjustment in the engine is expressed as a fraction of `ROUND_VALUE`.

**Rationale**: it is the one quantity in a draft that already means the same
thing in every league. It scales with the league's scoring (PPR inflates
receiver values, so it inflates `ROUND_VALUE` too), with team count (a 14-team
league loses more by waiting), and with the point in the draft (values flatten
late, so `ROUND_VALUE` shrinks, and so does every adjustment — which is correct:
reaching matters less in round 14 than round 2). It needs no constant.

It is also directly explainable, which Constitution VII rewards: "worth about
half a round" is a sentence an owner can act on. "+6.4" is not.

**Alternatives considered**:

- *Standard deviation of value across the pool.* Statistically respectable,
  but not a quantity any drafter has intuition for, and it barely moves as the
  draft progresses — so late-round adjustments would stay as large as
  first-round ones.
- *A flat point constant.* Rejected outright: violates Constitution II and III,
  as above.
- *A fraction of the top player's value.* Degenerates late — the best available
  player in round 15 is worth little, so all adjustments collapse to nothing,
  including the mandatory-slot logic that matters most there.

---

## §2 — Replacement level (FR-004), including FLEX

**Decision**: replacement level for position P is the projected value of the
player at the **league-wide starter boundary** for P:

```text
boundary(P) = teamCount × (dedicated starter slots at P + P's share of FLEX)
replacement(P) = points of the player ranked boundary(P) at P
value(player) = points(player) − replacement(position(player))
```

FLEX shares are **not configured** — they are allocated by value. The algorithm:

1. Take `teamCount × dedicatedSlots(P)` best players at each position P. These
   are the certain starters.
2. There remain `teamCount × flexSlots` slots, each eligible for a set of
   positions (ESPN slot 3 = RB/WR, 5 = WR/TE, 23 = FLEX = RB/WR/TE, 7 = OP).
3. Fill them greedily: repeatedly take the highest-value remaining player
   eligible for any unfilled flex slot, in the league's own scoring.
4. `boundary(P)` is then the total count of P absorbed by steps 1–3.

**Rationale**: this makes the baseline self-tuning per league *and* per scoring
with no knob. A full-PPR league pulls more receivers into flex than a standard
one — automatically, because the greedy fill sees the higher receiving values.
That is Constitution III working as designed rather than a table of assumed
flex splits.

Slot counts come from `RosterSnapshot.slots` (already parsed by 001 into
`league_snapshots.roster_json`) and `team_count`; nothing new is fetched.

**Edge cases fixed here**:

- A position with **zero** league-wide starter slots takes its own best player
  as the baseline, so every player at it values at ≤ 0 and is never recommended
  over a usable one.
- A position whose **pool is shorter than its boundary** takes its worst
  projected player as the baseline.
- Players with **no projection** (≈ 504 of the 1026-player universe) have no
  points, therefore no value; they rank last, behind every valued player, in
  name order. They are not excluded — FR-002 only excludes the *unavailable* —
  but they can never displace a valued player.

**Alternatives considered**:

- *Fixed flex splits per league type* (e.g. "flex is 60% RB"). Simpler, and
  wrong for exactly the leagues that differ most from the assumed shape.
- *VONA (value over next available)*, recomputing the baseline against who is
  actually left. Attractive, but it makes value depend on the draft state in a
  way that double-counts §4's survival rule, and it makes early-round values
  swing on single picks. Rejected in favour of a stable baseline plus explicit,
  named adjustments — which is also far easier to explain (VII).

---

## §3 — The ADP floor, detected rather than hardcoded

**Decision**: the floor is derived **per projection set** by density, and passed
into the engine as an input (`adpFloor`) so the engine stays pure:

```text
sort ADPs ascending
density(v) = players per unit ADP in a window around v
floor = the lowest v where density(v) > FLOOR_DENSITY_RATIO × median density
players with adp >= floor are treated as HAVING NO ADP
```

`FLOOR_DENSITY_RATIO = 10`.

**Rationale**: production measurement (2026-08-05) shows the separation is not
marginal — it is roughly **100×**. Below ADP 150: 145 players across ~148 ADP
units, about 1 player per unit. Between 169 and 171.6: 325 players across ~2.6
units, about 125 per unit. Any ratio between 5 and 50 finds the same boundary,
so the constant is not load-bearing and the rule survives ESPN moving its floor
between seasons or leagues.

Hardcoding `169.9` was rejected for exactly that reason: it is this season's
number, discovered by looking, and a season where ESPN's floor lands at 210
would silently turn 62% of the pool into a fabricated "safely surviving"
signal — the failure the spec's FR-022 was amended to forbid.

**Why it is an input, not a computation inside the engine**: the engine must be
pure and offline-replayable (FR-010, FR-014). Detecting the floor requires the
whole projection set; passing the detected value in keeps the engine a function
of its arguments and makes the detector independently testable.

---

## §4 — Two ADP rules, one shared ceiling

ADP answers two different questions, and the spec asks for both:

| Rule | Question | FR |
|---|---|---|
| `slot_value` | Has this player **fallen** past where the market takes him? | FR-005 |
| `survival` | Will he **still be here** at my next turn? | FR-022 |

**Decision**: keep them as two separately named, separately signed adjustments
— FR-024 requires survival be named, FR-027 requires each carry its own
magnitude — but **clamp their sum** to a single ceiling of
`ADP_COMBINED_CAP × ROUND_VALUE`, with `ADP_COMBINED_CAP = 0.75`.

`slot_value`: magnitude ramps with `(currentOverall − adp)`, positive when the
player has fallen past his ADP, zero when he is going at or before it. Reaching
is not punished — the owner may have reasons — it simply earns no bonus.

`survival`: let `gap = picksUntilTurn` (005's `snake.ts` already computes it)
and `nextTurn = currentOverall + gap`.

- `adp` absent or floored → **no adjustment, no claim in either direction**
  (FR-022, SC-012).
- `gap` null — no next turn, the owner's final pick → **rule does not apply**,
  and its absence is not reported as a missing signal (FR-023).
- `adp <= currentOverall` → certainly gone, full magnitude.
- `adp >= nextTurn` → likely to last, magnitude ramps to zero and no further.
- between → linear ramp.

**Rationale for the clamp**: both rules read the same column, so a player who
has fallen *and* will not last collects twice for one fact. Left unclamped, the
ADP signal could dominate value itself, which is the failure mode that makes a
draft assistant chase names. The clamp is asserted by test, not by inspection.

**Rationale for the linear ramp**: a smooth probability curve (logistic on ADP
standard deviation) is more defensible statistically, but ESPN publishes no ADP
dispersion, so its width would be invented — a fabricated precision on top of a
column that is already 62% floor. A linear ramp between two honest endpoints
claims exactly as much as the data supports.

---

## §5 — Signal adjustments (FR-006)

004 delivers every signal in one shape: `score` 0–100 (100 favourable) and
`rank` 1–32, per pro team. That uniformity is what makes one formula work for
all of them:

```text
adjustment(kind, player) = ((score − 50) / 50) × WEIGHT[kind] × relevance[kind][position] × ROUND_VALUE
```

| Constant | Value | Note |
|---|---|---|
| `WEIGHT.offense` | 0.30 | broadest signal; applies to every scoring position |
| `WEIGHT.sos` | 0.20 | real but noisy this far from the season |
| `WEIGHT.oline` | 0.25 | curated (PFF), and the most position-specific |
| `WEIGHT.bye` | 0.35 | a conflict is concrete, not a projection |
| `WEIGHT.scarcity` | 0.30 | observed from the draft itself, not forecast |

`relevance` is a fixed position matrix in code: O-line applies to RB and QB, not
to WR/TE/K/DST; offense applies to every offensive position including K;
SoS applies to all. A signal that does not apply produces **no adjustment**,
which is different from a zero one — the explanation says so (FR-013).

**Bye-week conflict**: a penalty when the candidate's bye matches the bye of a
player already on the owner's roster at the same position, scaled by how much of
that position the owner has already committed. Two starting RBs on the same bye
is a real problem; two of eleven bench players is not.

**Positional scarcity / run detection**: compare the share of the last
`teamCount` picks spent on the candidate's position against that position's
share of league-wide starter slots (§2's boundary counts). Elevated share ⇒
a run is on ⇒ positive adjustment. Measured backward from picks already made,
per FR-006; the forward-looking half is §4.

**Rationale for these magnitudes**: every one is under half a round, and their
plausible maximum sum (~1.4 × `ROUND_VALUE`, before the §4 clamp) is roughly one
round of value. That is the correct ceiling for the whole rule layer: signals
should be able to break a tie or move a player a round, never overturn the
value ranking outright. Value is the product; the rules are seasoning.

These five numbers are the honest content of "detailed rule tuning is its own
session" — they are first estimates, chosen for the right *order of magnitude*
and for the right relative ordering, and they are the intended subject of that
later session once 008's replay lab can score them.

---

## §6 — Where the engine runs, and how FR-015 is met

**Decision**: the engine is a **pure module computed on request**. No caching
layer, no precomputation inside the Durable Object.

```text
GET /api/leagues/:id/recommendations
  → load bundle (board, signals, league settings, preferred list, adpFloor)
  → read draft state from the DraftSession snapshot
  → recommend(bundle, state)  ← pure, no I/O
  → JSON
```

FR-015 ("ready before the owner is on the clock") is satisfied by **the client
requesting on the `on_deck` event**, which 005 already emits a full turn ahead.
That is the precomputation the constitution's Principle V asks for; it just
lives at the caller rather than in a cache.

**Rationale**: the D1 reads are the same ones `/board` already performs and
serves today, so the cost is known and shipping. The ranking itself is a few
arithmetic operations over ~1000 players — microseconds. Against an on-deck lead
time measured in tens of seconds, SC-005's 95% bar has enormous margin.

Putting the board inside the `DraftSession` DO was rejected: it would put ~1000
players of slow-changing reference data into per-league durable storage, on the
object whose one job is to be a correct, fast picture of the picks. 005 fought
hard for that object's simplicity — including the `blockConcurrencyWhile` fix
and the arming-off-the-request-path fix — and this would spend it.

**Risk, recorded**: if measurement later shows the bundle load dominates, the
fix is a cache in front of the *bundle* (which changes only when projections
refresh), not a cache of recommendations (which change every pick). That is a
007-era optimisation; it is not built now, per Constitution VIII.

---

## §7 — Preferred-list storage (FR-018, FR-020)

**Decision**: one table, cascading from `league_connections`.

```sql
CREATE TABLE preferred_players (
  connection_id  TEXT NOT NULL REFERENCES league_connections (id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  season         INTEGER NOT NULL,
  espn_player_id INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (connection_id, season, espn_player_id)
);
```

**The cascade is deliberately the opposite of `draft_archives`.** 005 gave the
archive no foreign key to `league_connections` at all, because an August draft is
season history that must outlive a March disconnect. A preferred list is not
history — it is live intent about a league the owner is still in. Disconnect the
league and it is meaningless, so it should go.

**Isolation (FR-020)** is enforced **in the query**, never by a comparison at a
call site — the pattern 005 established for `readBatchesAfter`. Every read and
write filters on `account_id`, so a wrong or missing check at the route cannot
expose another owner's list. `account_id` is carried on the row for exactly this
reason, even though it is derivable through `connection_id`.

**A set, not an ordering.** The spec says the owner "marks the players they
want" — a marked set. A ranked personal list is a different and larger feature
(it would compete with the engine's own ordering, which is the product).
`created_at` gives a deterministic tiebreak where one is needed (FR-017).

---

## §8 — Offline replay (FR-014, SC-009, SC-010)

**Decision**: the replay harness reads `draft_archives` + `draft_picks` and
drives the pure engine directly, with the network mock exhausted.

The corpus already exists: the 72-pick real draft committed during 005, which
replay proved agrees with ESPN's independent post-draft record on all 72 picks.
For each overall pick *n*, the harness builds the state from picks `< n`, calls
`recommend()`, and asserts SC-001, SC-002, SC-003 and SC-014's reconciliation.

SC-009's "no network" is asserted structurally, the way 005 asserts the ESPN
rate bound: activate `fetchMock`, `disableNetConnect()`, run the whole replay,
and let any outbound request throw. A comment claiming purity decays; an
exhausted mock does not.

**Rationale**: this is the same discipline that caught 005's silent pick
deletion — the bug that survived a structurally blind corpus test. The lesson
recorded there applies directly here: a replay whose fixtures cannot express the
failure proves nothing. So the replay explicitly includes the states the rules
are most likely to get wrong — the snake turnaround (gap of 1), the final pick
(no next turn), and the late rounds where almost every ADP is floored.

---

## Resolved unknowns

| Unknown from Technical Context | Resolution |
|---|---|
| Replacement-level baseline per league shape | §2 — starter boundary with value-greedy FLEX allocation |
| How adjustments combine | Additive in league currency (spec FR-027); §4 clamps the two ADP rules |
| Size of the preferred bound | §1 — one `ROUND_VALUE`, itself derived per league |
| Survival estimate math | §4 — linear ramp between honest endpoints; absent on floored ADP |
| ADP floor detection | §3 — density ratio, derived per projection set, passed in as input |
| Signal weights | §5 — five constants, all under half a round, summing to about one |
| Where the engine runs | §6 — pure module, on request; client triggers on `on_deck` |
| Preferred-list persistence | §7 — one table, cascading from the connection, isolated in-query |
| Offline replay mechanism | §8 — archive-driven harness with the fetch mock exhausted |

No NEEDS CLARIFICATION remains.
