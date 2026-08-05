# Quickstart: Recommendation Engine

**Feature**: 006 | **Spec**: [spec.md](spec.md) | **Contracts**: [contracts/api.md](contracts/api.md)

How to prove this feature works. Everything below runs offline — no live draft,
no ESPN, no network. That is the point of FR-014, and it is what lets the rules
be changed with confidence later.

## Prerequisites

- `npm install` done; migrations applied locally (`0009_preferred.sql` is new).
- The committed 72-pick draft corpus from 005 (`tests/fixtures/`), which replay
  proved agrees with ESPN's independent post-draft record on all 72 picks.

## Run the suite

```bash
npm test
```

Three projects run: workers, tap, draft. 006's engine tests are pure and land in
the workers project; the replay harness needs D1 and lands there too.

## The five things worth checking by hand

### 1. Determinism (SC-003)

```bash
npx vitest run tests/engine/determinism.test.ts
```

Runs `recommend()` twice over the identical state and compares serialised
output. Also asserts the type signature takes no `Date` and no `Env` — the
property is structural, not behavioural.

### 2. Full-draft replay (SC-001, SC-002, SC-010, SC-014)

```bash
npx vitest run tests/engine/replay.test.ts
```

Walks the archived draft pick by pick. At every one of the 72 states it asserts:
only available players are ranked; the shortlist head carries explanations; and
the reconciliation invariant holds —
`finalValue − rawValue === sum(adjustments.magnitude)` — for **every** entry, not
a sample.

The replay deliberately includes the three states the rules are most likely to
get wrong, because a corpus that cannot express a failure proves nothing:

- the **snake turnaround**, where the gap to the next turn is 1, not a round;
- the **final pick**, where there is no next turn at all (FR-023);
- the **late rounds**, where nearly every ADP is at ESPN's floor (FR-022).

### 3. No network (SC-009)

Asserted inside the replay by exhausting the mock, the way 005 asserts its ESPN
rate bound:

```ts
fetchMock.activate();
fetchMock.disableNetConnect();
// … full replay …
fetchMock.assertNoPendingInterceptors();
```

Any outbound request throws. A comment claiming purity decays; an exhausted mock
does not.

### 4. Two leagues, two answers (SC-004, Constitution III)

```bash
npx vitest run tests/engine/league-currency.test.ts
```

Evaluates one player pool under full-PPR and standard scoring and requires the
rankings to differ. This also exercises research §2's value-greedy FLEX
allocation: the PPR league should pull more receivers across the starter
boundary, moving the replacement baselines apart without any setting changing.

### 5. Isolation (FR-020, SC-011)

```bash
npx vitest run tests/contract/preferred.test.ts
```

Requests another account's preferred list and requires **404**, not an empty
list — an empty list would confirm the connection exists.

## Try it against a real league

The preferred-list page ships with this feature (FR-019) and is usable before
draft day:

1. `npm run dev`
2. Sign in, open a league, click **Preferred players**.
3. Search by name — the same client-side filter the league board already uses —
   and add a few.
4. Reload. The list persists.
5. `GET /api/leagues/<id>/recommendations` returns a ranked board. With no live
   draft the state is empty, so it ranks the full pool from pick 1 — which is
   itself a useful pre-draft sanity check on the rules.

## What you cannot check yet

**SC-005** (a recommendation ready before the clock, 95% of turns) needs a live
draft, because it is measured from the `on_deck` signal to the response. The
engine is computed on request and the client triggers on `on_deck`
(research §6), so the measurement belongs to 007's draft room. Until then the
figure is a design argument — tens of seconds of lead time against a request
costing about what `/board` costs today — not an observation.

Recorded here rather than quietly assumed, because 005 and 010 both shipped
tasks marked done that production later showed were never exercised.
