# Implementation Plan: Recommendation Engine

**Branch**: `006-recommendation-engine` | **Date**: 2026-08-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-recommendation-engine/spec.md`

## Summary

A pure function — `recommend(bundle, state) → RankedBoard` — is the whole
feature. It takes the league's own scored board (002/003), the context signals
(004), the live draft state (005), and the owner's preferred list, and returns a
total ordering of every available player with a five-player head that carries
full explanations.

Value is **points over positional replacement**, where the replacement boundary
is derived from the league's own roster settings with FLEX slots allocated
*by value* rather than by an assumed split — so a PPR league moves its own
baselines without a setting changing. On top of that sit seven named adjustments
(offense, SoS, O-line, bye clash, positional run, slot value, survival to next
turn) plus the preferred boost, each carrying its own **signed magnitude in the
league's currency**, all expressed as fractions of one derived unit:
`ROUND_VALUE`, the value given up by waiting a round.

Around the pure core: one new table for the preferred list, four small
endpoints, and a plain pre-draft page to build the list. No new platform
primitive, no new npm dependency, no change to any shipped contract.

**The single most important design constraint** is that `recommend()` takes no
`Date`, no `Env` and no `D1Database`. That is what makes "runs offline against
an archived draft" (FR-014, SC-009) and "reproducible from the archive alone"
(SC-010) properties of the type signature rather than promises about behaviour.

## Technical Context

**Language/Version**: TypeScript 5, ES2022 modules, `strict` throughout.

**Primary Dependencies**: none new. Hono (routing), React + Vite (the one page),
Vitest. The engine itself imports nothing.

**Storage**: D1. One new table, `preferred_players` (migration
`0009_preferred.sql`). Everything else is read: `players`, `player_projections`,
`projection_sets`, `signal_entries`, `league_snapshots`, `draft_archives`,
`draft_picks`.

**Testing**: Vitest, three projects (workers / tap / draft) as configured.
006's tests land in the workers project — the engine tests are pure, and the
replay harness needs D1. **Mutation testing is the verification discipline**, as
it was for 005 and 010: a rule that no test can detect the corruption of is not
tested.

**Target Platform**: Cloudflare Workers (`draft.neelamjai.com`), same as shipped.

**Project Type**: Web service + SPA. Existing structure.

**Performance Goals**: SC-005 — a recommendation ready before the owner is on the
clock in 95% of turns, measured from 005's `on_deck` event. The engine is
computed on request; the D1 reads are the same ones `/board` performs and serves
today, and the ranking itself is arithmetic over ~1000 players.

**Constraints**: pure and deterministic (FR-010); zero ESPN requests on the
recommendation path; no user-configurable rule surface (Constitution IV); the
rule layer must never be able to overturn the value ranking outright.

**Scale/Scope**: 1026 active players, of which ~522 carry projections; 32 pro
teams × 3 signal kinds; a 12-team × 16-round draft is 192 picks. One league per
request.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 — see below.*

| Principle | Verdict | How |
|---|---|---|
| **I. Spec-First** | ✅ | Spec approved and clarified (5 questions, 2026-08-05). This plan follows it. |
| **II. Any-League by Design** | ✅ | Nothing hardcoded. Replacement boundaries come from the league's `roster_json` and `team_count`; the FLEX split is derived by value; `ROUND_VALUE` scales with team count and scoring; the ADP floor is detected per projection set rather than pinned to this season's number. |
| **III. League's Currency** | ✅ | Value is `scoreStatLine()` against the league's own scoring items — the same path `/board` already uses. Every adjustment magnitude is in that same currency. A league-agnostic ranking is unreachable by construction: the engine is never handed one. |
| **IV. Rules Are Code** | ✅ | Seven weights and two sizes are module constants (research §4, §5). No endpoint, page, or column exposes them. The preferred *list* is user input, which Principle IV explicitly permits — "the only user-supplied inputs to the engine are the league context and the user's preferred-player list". |
| **V. Draft Day Is Unforgiving** | ✅ | FR-015 is met by the client requesting on `on_deck`, a full turn ahead. Withholding on a lapsed tap (FR-012) reuses 005's verdict rather than inventing a second liveness notion. Recomputation on revision bump (FR-016). |
| **VI. Recommend, Never Act** | ✅ | Pure computation. Zero outbound requests — asserted structurally by exhausting `fetchMock` across the whole replay, the way 005 asserts its rate bound. No ESPN write path exists in this feature. |
| **VII. Explainable** | ✅ | FR-009/026/027. Every adjustment carries a named reason and a signed magnitude, and the magnitudes must **reconcile** to the value delta — an explanation whose parts do not add up means something moved the ranking the owner was never told about. Asserted per entry across a full replay. |
| **VIII. Simplicity First** | ✅ | No new platform primitive, no new dependency, one new table, four endpoints, one page. No caching layer — see the recorded risk in research §6. Player search adds no backend at all (verified 2026-08-05). |

**Security & Privacy**: FR-020 isolation is enforced **in the SQL**, following
005's `readBatchesAfter` pattern, so a wrong check at a route cannot leak
another owner's list. No credential touches this feature; the engine reads D1
and never ESPN.

**No violations. Complexity Tracking is empty.**

One judgement call worth naming rather than burying: this feature ships a
**page**, in a spec whose Out of Scope says 007 owns the UI. That is deliberate
and recorded in the spec — the preferred list has no other owner, 007 comes
after, and without it the preference rule could never fire on a real draft day.
The page is a pre-draft editor, not the draft room.

## Project Structure

### Documentation (this feature)

```text
specs/006-recommendation-engine/
├── plan.md              # This file
├── research.md          # Phase 0 — every deferred number, resolved
├── data-model.md        # Phase 1 — one table, and the engine's shapes
├── quickstart.md        # Phase 1 — how to prove it works, offline
├── contracts/api.md     # Phase 1 — the engine contract and the HTTP shell
├── checklists/
│   └── requirements.md  # 16/16
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
migrations/
└── 0009_preferred.sql              # NEW — preferred_players

src/
├── engine/                         # NEW — all pure, zero platform imports
│   ├── value.ts                    #   replacement level, FLEX allocation, ROUND_VALUE
│   ├── adp.ts                      #   floor detection, slot_value, survival
│   ├── adjustments.ts              #   offense / sos / oline / bye / scarcity
│   ├── roster.ts                   #   needs, mandatory slots, the forced-pick rule
│   ├── preferred.ts                #   the bounded boost
│   ├── explain.ts                  #   assembly + the reconciliation invariant
│   ├── recommend.ts                #   recommend(bundle, state) — the contract
│   └── constants.ts                #   every weight and size, in one readable file
├── db/
│   └── preferred.ts                # NEW — account-scoped queries
├── api/
│   ├── recommendations.ts          # NEW — two GET routes
│   └── preferred.ts                # NEW — GET / PUT / DELETE
└── projections/
    └── adpFloor.ts                 # NEW — density detection, per projection set

web/src/pages/
└── PreferredList.tsx               # NEW — reuses LeagueBoard's search pattern

tests/
├── engine/                         # NEW — pure unit tests, one file per module
│   ├── value.test.ts               #   incl. the FLEX allocation
│   ├── adp.test.ts                 #   incl. floor detection and the shared clamp
│   ├── roster.test.ts              #   incl. FR-025's two sides of the boundary
│   ├── determinism.test.ts         #   SC-003
│   ├── league-currency.test.ts     #   SC-004
│   └── replay.test.ts              #   SC-001/002/009/010/014 over the 72-pick corpus
└── contract/
    ├── preferred.test.ts           # NEW — FR-020 isolation, SC-011
    └── recommendations.test.ts     # NEW — withholding, shapes, 404s
```

**Structure Decision**: `src/engine/` mirrors what 005 did with
`src/draft/reconcile.ts` — the pure core lives outside the platform layer, and
its purity is enforced by having nothing to import. The split into small modules
is not decoration: each is one rule, separately testable, and
`constants.ts` exists so that the later tuning session has exactly one file to
open. The engine never reaches for D1; `EngineBundle` is assembled by the route
and handed in.

## Phase 0 — Research

Complete. See [research.md](research.md). Nine unknowns resolved:

| § | Resolution |
|---|---|
| 1 | `ROUND_VALUE` — one round's worth of value, derived per league per pick |
| 2 | Replacement level via the starter boundary, FLEX allocated **by value** |
| 3 | ADP floor detected by **density ratio**, not hardcoded to this season's 169.9 |
| 4 | Two ADP rules (`slot_value`, `survival`), separately named, **sum clamped** |
| 5 | Five signal weights, all under half a round, summing to about one |
| 6 | Pure module computed on request; the client triggers on `on_deck` |
| 7 | One table, cascading from the connection, isolation enforced in-query |
| 8 | Archive-driven replay with the fetch mock exhausted |

Two of these deserve highlighting because they are where a plausible
implementation goes wrong:

**The ADP floor (§3).** 62% of the projected pool sits at ESPN's saturation
floor. Read literally, the survival rule would rank two-thirds of the board as
"safely surviving" and would be most confident in exactly the late rounds where
it is least true. Floored ADP is treated as **absent** ADP.

**The shared clamp (§4).** `slot_value` and `survival` read the same column and
would otherwise pay a player twice for one fact. Their sum is capped, and the
cap is asserted by test rather than trusted.

## Phase 1 — Design & Contracts

Complete.

- **[data-model.md](data-model.md)** — `preferred_players`, plus `EngineBundle`,
  `EngineState`, `RankedBoard`, `Recommendation`, `Explanation`, `Adjustment`.
  Notes why the preferred list cascades from `league_connections` when
  `draft_archives` deliberately does not: opposite lifetimes.
- **[contracts/api.md](contracts/api.md)** — the pure engine signature with its
  three contractual properties (determinism, totality, reconciliation), then the
  HTTP shell. Withholding is a **200**, not an error: the question was answered,
  and the answer is "I will not guess".
- **[quickstart.md](quickstart.md)** — five checks, all offline, plus an explicit
  statement of what cannot be verified until a live draft.

### Post-Design Constitution Re-check

Re-evaluated against the finished design. **Still passing, no new violations.**

Three things the design phase actually changed, rather than confirmed:

1. **Principle II got stronger.** The first sketch had a fixed FLEX split and a
   hardcoded ADP floor. Both were replaced by derivations — value-greedy
   allocation and density detection — because both would have been this
   league's and this season's numbers wearing a general-purpose disguise.
2. **Principle VII got a testable form.** "Explainable" became the
   reconciliation invariant, which is a property a test can fail on rather than
   a quality a reviewer has to judge.
3. **Principle VIII held a line.** A recommendation cache was designed and then
   cut. The recorded fallback (research §6) is to cache the *bundle*, which
   changes on the projection cadence, never the recommendations, which change
   every pick — but not until something measured says it is needed.

## Complexity Tracking

No constitutional violations. Table intentionally empty.

## Risks

| Risk | Why it is real | Mitigation |
|---|---|---|
| **The five signal weights are first estimates** | Nothing has scored them against outcomes; 008's replay lab is what will | They are chosen for order of magnitude and relative ordering, confined to `constants.ts`, and capped so the rule layer cannot overturn value. ROADMAP already records tuning as its own session. |
| **The ADP floor and the mandatory-slot rule fire in the same rounds** | Both activate late, and neither has met real data together | The replay harness explicitly includes the late-round states, not just a mid-draft sample |
| **SC-005 is unmeasurable until 007** | It is measured from `on_deck` to a rendered answer | Stated plainly in quickstart.md rather than marked done. 005 and 010 both shipped tasks marked complete that production later showed were never exercised — that is the failure this note exists to prevent. |
| **`ROUND_VALUE` degenerates at the very end of the draft** | With few players left, the top-to-`teamCount` gap collapses toward zero, shrinking every adjustment | Correct behaviour, not a bug — reaching matters less in round 16 — but the fallback path (fewer than `teamCount + 1` players remaining) needs its own test |
