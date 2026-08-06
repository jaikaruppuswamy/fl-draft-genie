# Implementation Plan: Shared Draft Sessions

**Branch**: `011-shared-draft-sessions` | **Date**: 2026-08-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-shared-draft-sessions/spec.md`

## Summary

Make a draft session serve the **league** rather than the account that happens to
be relaying, and take the user out of handling a credential — the two halves of
*nobody should have to pair anything*.

The technical approach turns on one decision that makes the rest small: **fan
out, do not re-key.** The session is addressed `connectionId:season`, and the
obvious move is to re-address it by league. That would also require lifting
per-manager perspective out of the Durable Object and reapplying it per viewer.
Instead, ingest arms and nudges **every** connected manager's session for that
league, and each object reconciles the same frames against its own scope — so
FR-002 (own perspective) and FR-005 (own settings) hold *by construction*, with no
migration and no new perspective layer.

Everything else follows: containment gets a behavioural rule (research §2),
reset clears in place rather than minting a connection (§5), enablement moves to
a gesture on Draft Genie's own page (§3), and the lab scopes frames by account
(§6).

**No new tables. No schema change. The Durable Object keeps its address.**

## Technical Context

**Language/Version**: TypeScript 5.7, ES2022

**Primary Dependencies**: none added. Changes land in `src/api/tap.ts` (fan-out),
`src/draft/session.ts` (arming, reset, ledger admission), `src/draft/feed.ts`
(convergence), `web/src/pages/DraftRoom.tsx` and `DraftTap.tsx` (state
reporting), `tap/` (enablement handshake), `scripts/lab-admit.ts` (account
scoping).

**Storage**: existing tables, unchanged. `tap_batches` already carries
`account_id`; `tap_pairings` already cascades from `accounts` only.

**Testing**: vitest — `tests/draft/**` (Durable Object, `isolatedStorage:
false`), `tests/tap/**` and `tests/room/**` (node), `tests/lab/**` (node).

**Target Platform**: Cloudflare Workers + Durable Objects; React SPA; desktop
Chrome userscript.

**Project Type**: change to shipped behaviour across five features — 005, 007,
008, 010 and the tap. No greenfield surface.

**Performance Goals**: 005's ratified budget unchanged — p95 ≤ 2 s, 100% ≤ 10 s
(measured 0.223 s). Fan-out multiplies reconcile work by the number of connected
managers (6–12), against three orders of magnitude of headroom.

**Constraints**: read-only against ESPN, tap strictly passive (FR-041); no
recommendation rule changes (FR-040); no ESPN credential read, logged or
transmitted (FR-042); ingest never accepts unattributable frames (FR-022,
FR-022a).

**Scale/Scope**: 6–12 managers per league; a handful of leagues.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 — see below.*

| Principle | Assessment |
|---|---|
| **I. Spec-First** | ✅ spec + clarify complete (5 questions, `724c86a`) before any code. |
| **II. Any-League** | ✅ improved by this feature. Live monitoring needs desktop Chrome; sharing a leaguemate's relay is the only route for a manager on an iPad or the ESPN app, which is most of them. |
| **III. League Currency** | ✅ untouched — each manager's board is still built from their own scoring snapshot. Fan-out preserves this because each session keeps its own scope. |
| **IV. Rules Are Code** | ✅ no rule, weight or threshold changes. FR-040 states it. |
| **V. Draft Day Is Unforgiving** | ✅ **and this is the feature's centre of gravity.** It removes a single point of failure (one manager's tap), makes state legible so a working system is not "fixed" under pressure, and stops a finished draft corrupting a live board. |
| **VI. Recommend, Never Act** | ✅ the tap stays strictly passive — no connection to ESPN, no message on that channel, no send path. FR-041. |
| **VII. Explainable** | ✅ unaffected; the engine's output is unchanged. |
| **VIII. Simplicity** | ✅ fan-out was chosen **because** it is the smaller change: no re-key, no migration, no per-viewer perspective layer. No new tables, no new dependency. |

**Security & Privacy**

- **The isolation rule is honoured, not weakened.** It enumerates *"another
  user's leagues, credentials, or preferred lists"* — none of which cross.
  Perspective stays per-account (FR-002); only the draft's picks are shared, and
  those are on every manager's screen in ESPN already.
- **The credential stays**, ratified in clarify with removal on the table.
  FR-022a additionally forbids inferring attribution from an armed session or a
  live-draft window — constraints that are weakest exactly when a draft is live.
- **The relayer is anonymous** (FR-003). The only genuinely private fact in the
  exchange is *that a particular person uses Draft Genie*, and it is not
  disclosed.
- ESPN credentials: untouched. The tap never reads them (FR-042).

**Technical Constraints**: the tap remains the single permitted browser
companion; no second artifact. Hosting unchanged.

**Result: PASS, no violations.** Complexity Tracking is empty.

One item named rather than hidden: **seven user stories is more than this project
normally puts in one feature.** It survives because they share a single root
cause and a single pair of rules, and because they were *already* split once
along the wrong seam (011/012) and had to be rejoined. If the work does not
cohere during implementation, the split to make is **US1 alone versus the rest** —
not back along the 011/012 line.

## Project Structure

### Documentation (this feature)

```text
specs/011-shared-draft-sessions/
├── plan.md              # This file
├── research.md          # Phase 0 — 6 sections; resolves the deferred ledger question
├── data-model.md        # Phase 1 — no new tables; what changes is scoping
├── quickstart.md        # Phase 1 — how to prove each story with two accounts
├── contracts/
│   ├── delivery.md      # who may send, who may receive, what each is promised
│   └── enablement.md    # the three-step setup and its prohibitions
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks output — NOT created here
```

### Source Code (repository root)

```text
src/api/tap.ts              # fan-out: arm + nudge every connected manager's session
src/db/leagues.ts           # enumerate connections for a league+season
src/draft/session.ts        # league-wide arming, reset(), ledger admission
src/draft/feed.ts           # convergence across several relays
src/api/tapEnable.ts        # (new) the acknowledgement endpoint
tap/                        # match Draft Genie's origin; receive enablement
web/src/pages/DraftRoom.tsx # three states, each with a remedy
web/src/pages/DraftTap.tsx  # four states; pairing instructions removed
scripts/lab-admit.ts        # scope frames by account, not connection
tests/draft/                # fan-out, arming, reset, ledger admission
tests/tap/                  # enablement handshake, passivity unchanged
tests/room/                 # state reporting
tests/lab/                  # account-scoped frames
```

**Structure Decision**: no new tree. Every change lands in the module that
already owns the behaviour, which is what makes this a scoping fix rather than an
architecture change. The one new file is the acknowledgement endpoint, because
there is no existing home for it.

## Phase Sequencing

| Phase | Delivers | Story |
|---|---|---|
| **1 — Fan-out** | league-wide arming and nudge; each session keeps its own scope | US1 |
| **2 — Honest state** | four tap states, three room states, each with a remedy | US2 |
| **3 — Enablement** | acknowledgement handshake; nothing displayed or copied | US3 |
| **4 — Containment** | ledger admission rule + recorded rejections | US4 |
| **5 — Reset** | clear in place, preserving perspective and history | US5 |
| **6 — The page** | pairing instructions removed | US6 |
| **7 — Lab scoping** | frames by account; leaguemate frames usable | US7 |

Phase 1 is the substantial one. Phases 2 and 4–7 are each small and independent
of each other; Phase 6 depends only on Phase 3.

**Suggested order if time is short**: 2, 4, 5 first — they are the three
sharp-edged bugs, all small, and none depends on Phase 1. US1 is the largest
value and the largest change, and taking it carefully is better than taking it
first.

## Post-Design Constitution Re-check

| Risk surfaced by the design | Verdict |
|---|---|
| Fan-out means N sessions reconcile the same frames — does the latency budget hold? | **Yes, with room.** 6–12 sessions against a measured p95 of 0.223 s and a 2 s budget. SC-001 checks it rather than assuming. |
| Does sharing frames leak anything? | **No.** Perspective never crosses (FR-002), the relayer is anonymous (FR-003), and the picks are already visible to every manager in the ESPN room. The constitution's isolation rule enumerates leagues, credentials and preferred lists — none of which move. |
| Does the ledger rule break recovery? | The real risk, and the reason the quickstart pairs the two cases. Rejection applies **only** where a session has never observed an incremental pick; a reload always has picks or is legitimately empty-and-early. |
| Is enablement-without-a-token a CSRF surface? | **No** — the gesture is on Draft Genie's own authenticated page, not a cross-origin call from ESPN. FR-018 and SC-012 assert it. |
| Does reset become a draft-day footgun? | Mitigated: refused or explicitly confirmed during a live draft (FR-030), and per manager under fan-out, so it cannot disturb a leaguemate. |
| Does accepting several relays let one manager corrupt another's board? | Frames are attributed and league-scoped; convergence is on pick identity. A relay can already only append picks for its own leagues — unchanged. |

**Result: PASS.** No violations, no justifications required, Complexity Tracking
remains empty.
