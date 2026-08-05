# Quickstart: Draft Room UI

**Feature**: 007 | **Spec**: [spec.md](spec.md) | **Contracts**: [contracts/ui.md](contracts/ui.md)

How to prove the draft room works — **without a live draft**. That is the point
of FR-024: the criterion this feature exists for must be a number before draft
day, not a hope on the day.

## Prerequisites

- `npm install`. **No new dependencies** — research §1 is what makes that true.
- The committed 72-frame corpus (`tests/fixtures/tap/replay-full.jsonl`), each
  frame carrying a real `observedAt`, plus the independent oracle it was verified
  against during 005.

## Run the suite

```bash
npm test
```

The draft-room reducer tests run in the existing **node** project — they need no
DOM, no browser and no fourth vitest project.

## The five checks that matter

### 1. SC-001, measured — a recommendation ready before the turn

```bash
npx vitest run tests/room/replay-timing.test.ts
```

Drives the reducer with the real corpus, advancing a **virtual clock** to each
frame's true timestamp, and for every turn belonging to the owner compares when
the recommendation became current against when the turn began. Reports the
fraction satisfied and asserts ≥ 95%.

It also asserts the number of turns evaluated. A replay that silently walks zero
turns looks exactly like one that walks them all — 005 shipped an SC-010 test
that passed while proving nothing, and this is the guard against repeating it.

### 2. SC-009 — the snake turnaround

Same harness, asserted separately. This is the case the inherited obligation
could not express at all, and the one where a regression shows first: the owner's
second consecutive pick has no earlier signal than the clock, so it is only ready
because the reducer refreshed on the pick before.

### 3. SC-004 / SC-005 — reload and reconnect

```bash
npx vitest run tests/room/recovery.test.ts
```

Three scenarios against the reducer:

- **reload** — replay from a cold state mid-draft; every pick returns, none twice;
- **gap** — withhold frames, then resume; the missing picks arrive exactly once;
- **epoch change** — a rebuild discards local state rather than merging a stale
  cursor into a reconstructed draft.

### 4. SC-011 — completion by either route, independently

```bash
npx vitest run tests/room/completion.test.ts
```

Runs the corpus to its end **twice**: once delivering only the `draft_complete`
signal, once delivering only the final pick with no signal. Both must reach the
completed state. A third run delivers them in conflict and asserts the
disagreement is *surfaced*, not silently resolved.

This matters more than its size suggests: the completion signal has **never
fired in production** (`draft_archives` holds zero rows), so this is the only
evidence that path works at all until a real draft produces some.

### 5. SC-010 — the three states, from a screenshot

Verified in the browser, because that is what the criterion says:

```bash
npm run dev
```

Open a league's draft room and step the reducer through idle, on-deck and
on-the-clock. The three must be distinguishable **without reading any text**.

## Try it against the ratified design

`/design/draft` still renders the design's mock data. The live room should be
visually indistinguishable from it apart from carrying real state — that is the
check that FR-019 held and the design was not quietly reopened.

## What you cannot check here

**A real draft.** Specifically:

- **Draft-end detection, the archive write and the keeper path** have never run
  against real data together. The harness proves the *screen* handles both
  completion routes; it cannot prove which route production actually produces.
- **The visual alert reaching you** — FR-023a is explicit that it works only
  while you are looking at the screen. There is nothing to test beyond that,
  because nothing more was promised.

Both are stated here rather than quietly assumed, because three times now this
project has shipped work marked done that production showed was never exercised.
