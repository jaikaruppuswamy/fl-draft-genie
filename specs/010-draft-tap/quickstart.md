# Quickstart & Validation: Draft Tap (010)

Contracts: [contracts/ingest.md](contracts/ingest.md). Design rationale and the
verified platform findings: [research.md](research.md).

## Setup

```bash
npm run migrate:local
npm run build:tap && npm run build && npm run dev
```

Install the built `web/public/draft-tap.user.js` into Tampermonkey, then pair it
from Draft Genie's settings page.

**Named supported configuration (FR-023)** — check these before anything else,
because each fails *silently*:

- Chrome ≥ 138
- Tampermonkey's **"Allow user scripts" toggle ON** — it defaults **OFF** on new
  installs, and the script simply never runs without it
- The tap's own preflight reports **page-world membership**. In an isolated
  world `window.WebSocket` is not the page's and the tap observes nothing while
  looking perfectly healthy

## Gate (US1) — capture before building

Everything downstream assumes field meanings this capture establishes. Run it
once, get all seven answers, because a second run costs a draft reset.

```bash
ESPN_S2='…' SWID='{…}' npx tsx scripts/capture-tap.ts --league <id> --season 2026
```

Capture **≥ 3 rounds**, and **force a mid-draft reconnect** (go offline > 4 s).

**Pass conditions:**

1. **Field 1 resolves.** The test league's `pickOrder` is non-identity
   (`[2,5,4,3,6,1]`), which separates team id from pick number in round 1; the
   snake reversal confirms it by round 2.
2. **Ledger and incremental frames agree** on pick identity after the forced
   reconnect. This also exercises the **SSE fallback**, which no public
   implementation has ever observed — ESPN is WebSocket-first and drops to SSE
   in ~7 s of bad network.
3. **`GM_xhr` reaches Draft Genie** from the ESPN page despite ESPN's CSP (10
   minutes: one request, read the status). This is the plan's one unverified
   load-bearing claim.
4. **Document-start actually fired** — i.e. entering the draft room reloads the
   document rather than navigating client-side. If it is an SPA transition, a
   `document-start` userscript is never injected and the whole delivery form
   needs rethinking.
5. **Sleep behaviour**: does the room re-emit the ledger on wake? The tap cannot
   reconnect ESPN's stream itself (FR-001), so if it does not, "resumed, no
   ledger, no messages" must become a loud reload prompt.
6. **Frames/origins**: is the channel created inside a cross-origin iframe or a
   popup? This single answer fixes the `@match` pattern, whether `@noframes` is
   safe, and the Worker's CORS allowlist.
7. **Independent oracle captured** — ESPN's post-draft `mDraftDetail` flush,
   which is derived independently of the tap and is what lets SC-010 fail.

**The raw capture is credentialed material** (FR-019a): it holds member
identifiers, names and chat. Sanitize before it leaves the machine; never commit
it raw. Only the sanitized derivative becomes a fixture.

## Validation scenarios

1. **Live relay (US2, SC-001/SC-002)** — draft in the test league with the tap
   installed and Draft Genie open on a second device: every pick appears, in
   order, acknowledged within 3 s of observation.
2. **Passivity (FR-001, SC-003)** — review the shipped script for any write to
   an ESPN origin, then run a draft with all egress blocked except Draft Genie's
   ingest and confirm the draft proceeds unchanged with no extra ESPN request.
3. **The page is unaffected (FR-002, SC-004)** — draft with and without the tap:
   ESPN's interface behaves identically, no control obstructed, no console
   error. Specifically confirm subclassing survives — a wrapper that drops
   `newTarget` breaks `class C extends EventSource` and would break the draft.
4. **Second socket ignored** — ESPN's commons bundle opens an unrelated
   WebSocket on the same page. Confirm none of its traffic is relayed and it
   does not trip the unrecognised counter.
5. **Privacy (FR-006a/b/c, SC-007)** — dump every transmission and the buffer:
   numeric ids, pick positions and timing only. No name, no member identifier,
   no chat, and no `location.href` — the draft-room URL carries the owner's SWID
   as a query parameter.
6. **Filter-before-buffer** — inspect script-manager storage mid-draft: it holds
   filtered messages, never wire frames.
7. **Outage (FR-008, SC-005)** — block ingest for 60 s mid-draft: picks buffer
   and deliver in order on recovery, none lost. Verify recovery is
   **event-driven**: a hidden tab throttles chained timers to one per minute,
   which alone would fail this.
8. **Reload and sleep (FR-009)** — reload mid-draft and sleep the machine: state
   recovers via ESPN's re-sent ledger, and the timing epoch increments rather
   than producing stamps that silently run late.
9. **Two tabs (SC-013)** — same league in two tabs: exactly one instance of each
   pick downstream, and the ordering is still reconstructible.
10. **Revocation (SC-008)** — revoke the pairing: relaying stops within one
    message, the buffer is retained, and the ESPN draft is unaffected.
11. **Unrecognised vs known-non-draft (FR-017a, SC-009)** — feed a `PONG` (the
    inbound keep-alive; `PING` is client→server only) and an invented verb: the
    first is dropped silently, the second is counted and reported loudly.
12. **Draft end (FR-024, SC-014)** — on completion the tap stops and says so;
    when it cannot tell, it says that instead of going quiet.
13. **Version skew (FR-022)** — point the tap at an ingest that rejects its
    version: `409`, `version-rejected` surfaced, buffer kept, update prompted.
14. **Replay (SC-010)** — replay the committed corpus offline through decode and
    filter; compare against the **independent** oracle, not against itself.
15. **Install (SC-006, SC-012)** — clean profile, follow the written steps: under
    10 minutes, verified via `/api/tap/health` with no live draft, and the
    iPad/mobile limitation is encountered without having to search for it.

## Test suite

```bash
npm test
```

Two projects in one run: the existing workers-pool suite (D1, bindings) plus a
`node` project for `tap/**`'s pure modules. Browser-side code cannot run under
the workers pool, which is why the split exists.

**The CORS preflight is a contract test, not an afterthought** — assert the
`OPTIONS` response, not just the POST.

## Draft-day notes (feeds 009's runbook)

**Do these before the draft, not during it:**

1. **Force a script-manager update check.** Tampermonkey checks on its own
   schedule and exposes no API to force one, so a fix published today may not
   reach you automatically. Dashboard → the tap → *Check for userscript updates*.
2. **Confirm "Allow user scripts" is still on** at `chrome://extensions`. A
   Chrome update can reset it, and the script then silently never runs.
3. **Open the ESPN draft room and check for the badge.** It shows the tap
   version and its state. No badge means it did not attach — which is the one
   failure that looks identical to a quiet draft, hence the preflight.
4. **Run the health check** on the Draft tap page. That proves the ingest is
   reachable; the badge proves the tap is attached. Both, not either.

**During the draft:**

- **Keep the ESPN draft-room tab open.** That tab *is* the tap; closing it stops
  the feed and 005 will report "not receiving picks".
- Drafting from an iPad, a phone, or the ESPN mobile app means **no live
  monitoring**. This is a decision, not a defect.
- A pick every ~1 second is normal under autodraft (measured: median 3.75 s,
  minimum 1.0 s). Bursts that fast arrive as one observation, which 005 FR-020a
  handles.

**If something looks wrong:**

- The badge names the state and what to do. `incompatible` means picks are
  **not** being captured — the loudest state, deliberately.
- The [self-test](/draft-tap/self-test) replays a saved capture through the
  tap's own decode and filter with no draft running, which is the fastest way to
  tell a protocol change from a configuration problem.



- Force a script-manager update check before the draft; managers check on their
  own schedule and expose no force-check API, so FR-022's "fix in minutes"
  depends on this manual step.
- Keep the ESPN draft-room tab open — it *is* the tap. Closing it stops the
  feed, and 005 will report "not receiving picks".
- Drafting from an iPad, a phone or the ESPN mobile app means **no live
  monitoring**. This is a decision, not a defect.
