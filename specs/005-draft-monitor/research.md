# Research: Draft Monitor (005)

Platform claims below were verified against the **installed** type definitions
(`node_modules/@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers@0.8.71`)
and current Cloudflare docs, and several were confirmed empirically by building a
throwaway Durable Object and running it in this repo's own Vitest pool. Where a
claim could not be verified it is marked **UNVERIFIED** and the design degrades
safely rather than depending on it.

---

## 0. Gate: is `mDraftDetail` actually live during a draft? (BLOCKING)

**Finding**: The premise of this whole feature — that polling ESPN's
`mDraftDetail` view reveals picks *as they happen* — is **not established**.
The only published empirical test of a real 2026 ESPN draft reports that the
view **freezes for the duration of the draft and flushes every pick atomically
at completion**. The `espn-api` maintainer has said the same in 2022 and 2024.
The three public repos that do poll it live show no evidence of having
validated it against a running draft. The freeze was observed on an **auction**
draft, so snake is genuinely unknown.

**Decision**: Make this **Gate 0** — the first task of implementation, before
any DO code is written. Sample a real ESPN draft **continuously at ≤ 5 s for
its whole duration**, retaining four landmarks (order published + skeleton,
room open, mid-draft, complete) as named files — SC-003 and SC-010 are defined
over a continuous observation sequence, so a sparse capture cannot exercise
them. Fixtures are **sanitized on write** (ESPN's `mSettings`/`mTeam` carry
SWID GUIDs and real names). Everything downstream is written against those
fixtures.

**If the view is live** (expected case): the plan below proceeds unchanged.

**If the view is frozen**: SC-001's 12 s / 4 s latency targets are
unachievable by polling and the feature needs a new transport. Known
candidate, **UNVERIFIED**: ESPN's own draft room streams over
`wss://fantasydraft.espn.com/game-1/league-<id>/JOIN?…&4=<SWID>`. Two hazards
make this a spec-level decision, not an implementation detail: connecting a
second client with the same SWID may **evict the owner from their own draft
room**, and a bidirectional draft socket sits uncomfortably close to
Constitution VI (read-only). Do not adopt it inside this feature — return to
`/speckit-clarify` with the capture in hand.

**Rationale**: The cheapest possible experiment, run first, against the one
assumption that can invalidate the feature. A mock draft in any of the owner's
leagues satisfies it.

---

### Gate 0 result (2026-08-03) — **FAILED**

`mDraftDetail` does **not** reflect picks during a live snake draft. The
polling premise of this feature is disproved.

**Method**: league `DraftGenieTester`, 6 teams, SNAKE, 12 rounds (72 pick
slots), season 2026. A genuine live draft was run from six separate Chrome
profiles with six human managers — **~30 picks across 5 rounds over 17.5
minutes**, at human pace (two autopicks). Throughout,
`scripts/capture-draft.ts` polled `?view=mDraftDetail` every 5 s with valid
credentials: **207 samples**, 06:50:56Z → 07:08:30Z.

**Result**: `draftDetail.picks` was a 72-entry skeleton with `playerId: -1` on
every entry, and **not one byte of it changed** across all 207 samples. The
only variation in the entire payload was `draftDetail.inProgress` flipping
`true → false` when the draft was stopped — two distinct payload hashes for the
whole run. Zero picks were ever observable.

This is, as far as we can establish, the first published confirmation for a
**snake** draft; the only prior report was auction (see the blocking risk
above), which left snake genuinely unknown. It is now known.

**Consequences**:
- SC-001 (12 s / 4 s latency) is unachievable by polling this view. So are
  SC-002, SC-003 and the whole event stream, which derive from observing picks.
- US1, US2 and US4 have no data source. Phases 2–9 of tasks.md are blocked.
- The feature cannot proceed on its current design. Per T003 this returns to
  `/speckit-clarify` — but see the open question below, which determines what
  the clarification is actually *about*.

**Still open — what the next experiment must answer**: the capture polled
`mDraftDetail` alone on samples 2..207 (following §4's "cheap poll" guidance,
which was wrong for a capture tool), so only 1 of 207 samples contains
`teams[]`. Whether **`mRoster`/`mTeam` reflect picks live is therefore
untested**. That distinction decides everything:

- If rosters move live → the poll *source* changes and most of the design
  (Durable Object, cadence, reconciliation, events) survives largely intact.
- If nothing in the v3 read API moves → the feature needs a different transport
  (the draft-room WebSocket, which carries an unresolved Constitution VI
  question) or a re-scope.

`scripts/capture-draft.ts` now requests all four views on **every** sample —
ESPN accepts multiple `view=` params in one request, so this costs no
additional requests — and reports per-section change detection at the end.
`scripts/probe-draft.ts` answers the same question in one request against a
draft that is stopped mid-way with picks already made.

### Gate 0 follow-up (2026-08-03) — the open question is closed, negatively

The "does `mRoster`/`mTeam` move live?" question no longer needs a second
draft. **It does not.** Two independent confirmations:

1. In a completed 2026 draft, **all 64 DRAFT transactions share a single
   `proposedDate`, identical to `draftDetail.completeDate`** — the fingerprint
   of one atomic write at completion, not incremental updates.
2. A third party's real-draft capture reports directly that `mRoster` does not
   update during a draft either.

So the ESPN **league database is written once, when the draft completes**.
That explains our Gate 0 result exactly, and it means *no* v3 read view can
carry live picks. Also falsified along the way: `view=draftInit` exists but its
pick objects contain only `{id, teamId}` — the string `playerId` does not occur
anywhere in its `draftDetail`, even for a finished draft.

**The only live source is the ESPN draft-room channel** (`fantasydraft.espn.com`,
SSE transport, plain-text verbs including `SELECTED <field1> <playerId>
<slotId>` and an `INIT <base64>` pick ledger). Two things follow, and they pull
in opposite directions:

**A server-side observer connection is not available** *(evidence: strong)*.
`JOIN` is the sole entry verb and it registers a **participant** — sets
`isOnline`, broadcasts `JOINED`, writes a "member joined" chat line — and the
client must **write** a `PING` every 15 s, so no passive read-only posture
exists at the protocol level. The `securityToken` is pick authority, not a read
credential. Nobody in the public corpus has ever demonstrated an independent
server-side observer connection against a live draft; the one project that
opens its own socket is fantasy *baseball*, runs under a separate co-manager
bot account, and has no record of capturing a live pick. Duplicate-session
eviction (`DUP_LEAVE`) is real but is the *weaker* argument — the client-side
chain is confirmed, the server-side trigger inferred. The disqualifier is
simpler: **connecting means participating**, which Constitution VI forbids.

**A passive tap on the user's own draft-room socket does work**
*(evidence: confirmed against live drafts, multiple independent parties)*. A
userscript/extension injected at `document_start` into the page the user has
already opened wraps `window.WebSocket`, mirrors inbound frames, and POSTs them
in small batches to a Worker ingest route. It opens **no** additional
connection, cannot evict, never joins, and has **no send path at all** —
Constitution VI is clean. At least two projects have captured real `SELECTED`
frames this way with sub-second latency, and a commercial extension ships the
same approach.

Its cost is not technical but **governance**: it introduces a browser artifact
the user installs, which the constitution's Technical Constraints do not
currently contemplate ("responsive web app usable on iPad and desktop browsers.
No native app."). An extension is not a native app, but it is not purely the
web app either — and it does not exist on iPad Safari, so drafting from an iPad
would lose live monitoring. **That is a constitution-level question, not an
implementation detail**, and it is what `/speckit-clarify` must decide.

**Do not build on this yet**: `SELECTED` field 1 is genuinely unresolved — one
project's protocol doc and its own code disagree on whether it is `teamId` or
the pick number, and round-1 data cannot disambiguate them. Any reconciler
written against that field must resolve it first.

**Also resolved by this capture** (three of §4's UNVERIFIED items):
- Skeleton `teamId` **is** pre-filled on empty snake slots. Picks 1–6 carried
  `[2,5,4,3,6,1]`, exactly `settings.draftSettings.pickOrder`; picks 7–12
  carried the reverse. The remaining-schedule computation can rely on it.
- `pickOrder[0]` **is** the team holding overall pick #1 (§7's assumption
  confirmed).
- `autoDraftTypeId` was `0` throughout; `bidAmount`/`nominatingTeamId` were `0`
  in every slot, confirming they are auction-only and belong in FR-006a's
  format-specific detail slot, not the shared shape.
- Keepers remain **unverified** — a fresh draft cannot contain them.

---

## 1. Durable Object as the draft session

**Decision**: One SQLite-backed `DraftSession` DO per league connection per
season, addressed by `env.DRAFT_SESSION.getByName(\`${connection_id}:${season}\`)`.
Live state is a single JSON blob under key `"session"` in the **synchronous KV
API** (`ctx.storage.kv`). The Worker calls the DO by **RPC** (`ensureRunning`,
`snapshot`, `shutdown`); `stub.fetch()` is reserved for the WebSocket upgrade.

**Rationale**: `league_connections` is `UNIQUE (account_id, espn_league_id,
season)` with a UUID primary key (`migrations/0001_init.sql:43`), so keying on
the connection id gives FR-001's guarantee for free — two users in the *same*
ESPN league get different DOs. RPC is the default at compatibility date
2026-07-01. Verified: `getByName(name, options)` exists at
`workers-types/index.d.ts:623-641`.

**Registration — use the legacy `migrations` array, not `exports`**: current
docs recommend the declarative `exports` field for new Workers, but the
installed `@cloudflare/vitest-pool-workers@0.8.71` pins
`wrangler@4.35.0`/`miniflare@4.20250906.0`, which predate it and **silently
provision the DO key-value-backed in tests** while production is SQLite-backed.
Empirically reproduced this session: under `exports`, `ctx.storage.kv.put()`
threw *"only available for SQLite-backed Durable Objects"*; under
`migrations: [{ tag: "v1", new_sqlite_classes: ["DraftSession"] }]` both
`kv` and `sql` worked. This is reversible — adopt `exports` after the test
dependency is bumped.

```jsonc
"durable_objects": { "bindings": [{ "name": "DRAFT_SESSION", "class_name": "DraftSession" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["DraftSession"] }]
```

**Alternatives rejected**: key-value-backed DO — Cloudflare no longer permits
creating KV-backed namespaces on accounts that lack one; D1-only with cron
polling — cannot hold WebSockets or poll faster than 1/minute; `newUniqueId()`
— unaddressable from a later request without storing the id.

**Gotchas**:
- `DurableObject` has **no** `scheduled()` handler and `DurableObjectNamespace`
  has **no enumeration method** (`listDurableObjectIds` exists only in
  `cloudflare:test`). A D1 index of live sessions is therefore mandatory, not
  optional, for FR-014a.
- `deleteConnection` (`src/db/leagues.ts:182`) mints a **new** UUID when a league
  is re-added, orphaning the old DO — which keeps its alarm chain and keeps
  hitting ESPN with no D1 row behind it. A read-only leak against Constitution VI
  and a cost leak. `shutdown()` RPC (deleteAlarm + deleteAll, refuse to re-arm)
  must be called from `deleteConnection`.
- `tsconfig.json` sets `noUncheckedIndexedAccess`, so the docs'
  `const [client, server] = Object.values(new WebSocketPair())` will not compile —
  use indexed access on the pair.
- The `DraftSession` class must be re-exported from `src/index.ts` (currently
  exports only `default`), and `Env` gains
  `DRAFT_SESSION: DurableObjectNamespace<DraftSession>` via a **type-only**
  import to avoid a runtime cycle.

---

## 2. Poll cadence: one self-rescheduling alarm — ⛔ **RETIRED (round 4)**

> This section described the live pick cadence. Gate 0 disproved polling as a
> source of live picks, and round 4 removed the tier structure entirely: the tap
> pushes at one rate regardless of whose turn it is, so there is nothing for an
> attended/near-turn tier to change. What survives is the *back-off ladder* and
> the idea of a pure cadence function, both now scoped to ESPN's remaining
> pre-draft and flag reads — see §8 and `src/draft/schedule.ts`. Kept for the
> record; do not implement from it.

**Decision**: A single self-rescheduling DO alarm drives all four tiers —
**3 s** (owner within 3 picks), **10 s** (live, client attached), **30 s**
(live, unattended), **60 s** (armed, pre-draft heartbeat). `nextPollDelayMs()`
is a pure function, unit-tested offline. `alarm()` never rethrows.
`ctx.getWebSockets().length > 0` answers "is a client attached".

**Rationale**: Alarms are the only durable timer a DO has; the tier decision is
pure arithmetic over state the DO already holds. Keeping the decision in a pure
function is what makes the ratified cadence testable without wall-clock waits.

**Four corrections that the naive loop gets wrong** (all verified):

1. **Arm the safety alarm FIRST.** The pending alarm is *consumed* when the
   handler starts, and DOs shut down without a hook on deploys, runtime updates,
   and host moves. If the handler dies during the ESPN fetch, **no alarm exists**
   and polling is dead until the 5-minute cron. `setAlarm(now + tier)` must be
   the first statement of `alarm()`; the tail reschedule overrides it.
2. **A *caller* must not test `getAlarm() === null`.** Docs state `getAlarm()`
   returns `null` while the handler is executing, so a cron testing it from
   outside would routinely see `null` on a *healthy* session and clobber its
   schedule.
   **SUPERSEDED IN PART (2026-08-02, post-`/speckit-analyze`)**: this originally
   read "test persisted staleness instead", which is wrong — a session degraded
   by an ESPN outage is indistinguishable by timestamp from a dead one, so a
   staleness threshold rebuilds live sessions *during* an outage (see §5). The
   ratified resolution is that `ensureRunning()` evaluates `getAlarm()` **inside
   the object** under `ctx.blockConcurrencyWhile`, where the race does not
   exist, and additionally guards on `completed_at IS NULL`. Persisted staleness
   is never a restore trigger.
3. **Re-anchor when behind.** After hibernation, a redeploy, or a 60 s back-off,
   `dueAt + next` is in the past and the minimum-gap clamp yields a burst of
   catch-up ESPN polls. `if (dueAt + next <= now) dueAt = now;`.
4. **`alarm()` must be total.** An uncaught throw triggers at-least-once retry
   with exponential backoff from 2 s for up to six retries — an escaping ESPN
   error re-polls. Catch inside; emit a `degraded` status frame; never throw.

**Alternatives rejected**: in-memory `setTimeout` loop (dies with the isolate —
violates Constitution V); cron-only polling (1-minute floor, ~20× too slow);
one alarm per tier (no such thing — a DO has exactly one alarm).

**Gotchas**:
- Alarm timing is **best-effort**: "can be delayed by up to a minute due to
  maintenance or failures while failover takes place." SC-001's 3 s tier is
  therefore *typical*, not bounded — stated as such in the plan.
- Alarm delivery latency has **no published bound** (**UNVERIFIED** — nothing in
  the alarms API, limits, or rules-of-DO pages states one).
- **Duration-cost trap**: a non-hibernating DO bills 0.128 GB-s per wall-clock
  second ≈ 11,059 GB-s/day — 85% of the Free plan's 13,000 GB-s/day from a
  *single* object. A 3-hour draft ≈ 1,382 GB-s. Hibernation requires 10 s of no
  events, and the 10 s baseline sits exactly at that threshold, so an attended
  session effectively never hibernates. The postponed-draft edge case therefore
  needs a **hard absolute deadline**, not an indefinite heartbeat.
- `ctx.getWebSockets()` still returns sockets whose peer vanished without a
  close frame, so a dead client can hold the 10 s tier instead of 30 s — age
  them out with `setWebSocketAutoResponse()` + `getWebSocketAutoResponseTimestamp()`,
  which is explicitly free of wall-clock charge.
- `EspnError` has a `league_not_found` (404) code the cadence input must handle —
  otherwise the session hammers a 404 forever up the back-off ladder.
- Migrations cannot be gradually deployed: ship the `new_sqlite_classes` migration
  as a plain deploy **well before draft day**.

---

## 3. WebSocket transport

**Decision**: WebSocket **Hibernation API** (`ctx.acceptWebSocket(server)`),
handshake authenticated by the existing `dg_session` cookie plus a strict
`Origin` allowlist on a same-origin upgrade, **strictly server → client**
frames, opening snapshot frame sent inside `fetch()` *before* returning the 101,
and `?since=N` cursor resume.

**Rationale**: `ctx.getWebSockets()` returns **0** for `server.accept()`
sockets, so FR-007a's attended/unattended cadence flip is *impossible* without
the hibernation API — that, not memory savings, is why it is mandatory here.
Authentication resolves entirely at the edge in the existing `/api/*` middleware
(`src/api/app.ts:34-42`), so the DO never sees the cookie: the Worker
synthesizes a clean upgrade request via
`stub.fetch("https://do/stream", { headers: { Upgrade: "websocket" } })`.
That keeps FR-018 satisfied and FR-024a trivially true.

**Message envelope**: every frame carries `{ type, epoch, seq, … }`. The client
stores the cursor, sends `?since=N` on reconnect, **discards** `seq <= cursor`,
and forces a full resync only on a true forward gap.

**Alternatives rejected**: SSE (no server-push protocol advantage here, and the
attendance signal would need separate bookkeeping); polling the app's own API
(FR-015 forbids); passing the session cookie through to the DO (needless secret
propagation).

**Gotchas** (all reproduced against the pinned runtime):
- **Never let middleware mutate the proxied 101.** `c.res.headers.set(...)`
  after `await next()` throws `Can't modify immutable headers` and 500s the
  upgrade. Today's middleware is safe; record this as a standing constraint,
  because a future request-id or CORS decorator would silently kill the stream.
- The class **must** define `webSocketClose()` (and `webSocketError()`) or every
  disconnect raises an uncaught `TypeError`. But **delete `ws.close(code, …)`
  from the body**: a browser close surfaces code 1005, and `close(1005)` throws
  *"Invalid WebSocket close code"* on the pinned runtime.
- `serializeAttachment` is capped at **2,048 bytes** on the pinned runtime, not
  the 16,384 the docs state.
- Input gates do **not** protect across `await fetch(ESPN)` — a WS upgrade can
  land mid-poll. FR-016's no-gap/no-duplicate property therefore requires the
  monotonic `(epoch, seq)` cursor; it is not free from the synchronous KV API.
- Deploying a new Worker version restarts every DO and disconnects all
  WebSockets — mid-draft deploys drop every client. Storage and the pending
  alarm survive, so polling resumes on its own. "No deploys during a draft" is a
  009 runbook item.

---

## 4. ESPN's `mDraftDetail`

**Decision**: Model `draftDetail.picks[]` exactly as ESPN ships it; treat each
pick's own `teamId` / `roundId` / `roundPickNumber` / `overallPickNumber` as
authoritative; **filter to `playerId > 0`**; poll `?view=mDraftDetail` **alone**
while live, fetching `mSettings` + `mTeam` + `mRoster` only at arm, rebuild, and
state transitions.

**Rationale**: One view per poll is the cheapest thing that satisfies FR-008,
and per-pick fields make FR-012 reconciliation a keyed diff rather than
arithmetic.

**State detection**: `inProgress:false && !drafted` = not open; `inProgress:true`
= **room open** (not necessarily picking — the first `playerId > 0` pick is what
proves picking began); `drafted:true` (+ `completeDate`) = complete.

**Gotchas**:
- `picks.length` is the **skeleton** length from before pick one, not progress.
  ESPN pre-populates a full placeholder array. Legitimate D/ST player ids are
  **negative**, so the filter is `playerId > 0`, never `playerId !== -1`.
- Keepers have **two** representations: `keeper:true` picks occupying real slots
  in `picks[]`, *and* pre-draft rostered players in `teams[].roster.entries[]` —
  the latter only via `view=mRoster`, which this repo does not currently request.
  Union them by `playerId` at arm/rebuild so FR-011 never double-counts, and
  persist both, because after the draft a roster entry alone cannot tell you the
  player was a keeper. **UNVERIFIED**: whether ESPN gives keepers real overall
  pick numbers — if not, they must be excluded from the ordered pick list or they
  corrupt the reconciliation. No available capture has `keeperCount > 0`.
- Skeleton `teamId` pre-assignment on *empty* snake slots is **UNVERIFIED**
  (inferred from the auction case, where `nominatingTeamId` was pre-filled — and
  where it diverged from who actually acted on 12 of 51 lots). Prefer skeleton
  `teamId` when present, fall back to the snake formula, and never present a
  computed slot as if ESPN reported it.
- `bidAmount` / `nominatingTeamId` are auction-only and always 0 in snake — they
  belong in FR-006a's format-specific detail slot, never the shared shape.
  `autoDraftTypeId` is an undocumented enum: store the raw integer, expose only
  `autodrafted = autoDraftTypeId !== 0`.
- **No repo fixture contains a picks array today.**
  `tests/fixtures/espn/draftdetail-published.json` stops at `pickOrder` and was
  hand-authored to the documented shape, not recorded. This is Gate 0's output.

---

## 5. Storage split: DO authority, D1 archive

**Decision**: **One authority, one archive.** The DO is the sole authority for
live state (single JSON blob; rosters, available set, picks-until-my-turn and the
remaining schedule are all *derived at read time*, never stored). D1 holds only
(a) a `draft_sessions` header row that is the cron's work-list, and (b) the
permanent archive in `draft_picks` + `draft_keepers`, written once at completion.
No per-pick write-through: D1 sees lifecycle transitions, a 30 s-throttled
heartbeat, and the final archive.

**Rationale**: FR-014 guarantees a rebuild from ESPN, so mid-draft D1 durability
buys nothing that ESPN does not already provide — while per-pick write-through
would put a D1 write on the 3 s path for every league.

**Cascade decision (research flagged this as needing an explicit call)**: the
`draft_sessions` header cascades from `league_connections`, but the **archive
tables key on `account_id`** and cascade from `accounts`. Disconnecting a league
therefore does **not** destroy its retained draft history (FR-013 keeps its
promise, and 008 keeps its corpus), while deleting an account still removes
everything (per-user isolation).

**Gotchas**:
- `league_snapshots` is **one row per connection, overwritten on every re-sync**
  (`src/db/leagues.ts`), so the archive cannot reference it — `teams_json`,
  `order_json` and `my_team_id` must be **copied** at archive time or FR-013's
  "reconstruct without ESPN" silently rots at the next sync.
- **Do not restore sessions by thresholding `last_observed_at`.** A session
  degraded by an ESPN outage (FR-022: must keep serving) is indistinguishable by
  timestamp from a dead one (FR-014a: must be rebuilt), so a threshold produces
  spurious rebuilds *exactly during an outage*. The restore predicate is
  "`archived_at IS NULL` and `getAlarm()` is null". `last_observed_at` exists for
  the FR-025 diagnostic page and 009's alerting only.
- D1's **100-bound-parameter** cap means multi-row inserts into `draft_picks`
  (9 columns) hold at most 11 rows; chunk at 10. A 192-pick draft archives in
  ~24 statements in one `db.batch()`.
- FR-024a is stricter than a cache: credentials are decrypted **per ESPN
  request**, never held in DO storage or memoized as instance state. That places
  exactly one D1 *read* on the poll path — and is what lets re-entered
  credentials take effect on the very next poll (FR-023).

---

## 6. Testing strategy

**Decision**: Two Vitest projects under one `npm test`. The existing config is
untouched (`isolatedStorage` default). A **second root-level project config**
covers `tests/draft/**` with `isolatedStorage: false`, because **WebSockets in
DOs are unsupported with per-file storage isolation**. The bulk of the logic is
tested through a **pure `reconcile()` reducer** with no DO involved; SC-010's
full-draft replay runs DO-free. ESPN is faked with `fetchMock` +
`disableNetConnect()`, which is the *structural* guarantee for SC-008 (zero
writes to ESPN).

**Rationale**: Pushing event derivation into a pure reducer is what makes
FR-021's "consumable by an offline replayed sequence" true by construction
rather than by assertion — and it keeps the expensive DO harness for the few
behaviors that genuinely need it.

**Gotchas**:
- Both project configs must sit at **repo root**: a config in a subdirectory
  makes that directory the project root (include globs match nothing), and even
  with an explicit `test.root` the pool resolves `wrangler.configPath` relative
  to the config file's own directory. The isolated-storage/WebSocket failure is
  reported against whichever test is on the stack — do not chase the named test.
- The replay driver's fake clock must be anchored **at or after** the real
  `Date.now()`. With system time faked into the past, `setAlarm(fakeNow + delay)`
  lands in the real past and miniflare's scheduler fires `alarm()` spontaneously —
  with a self-rescheduling alarm that is a runaway loop that quietly inflates
  event counts.
- Never assert cadence against the real clock (a 7000 ms `setAlarm` measured
  6999 ms). Wrap cadence assertions in `vi.useFakeTimers({ toFake: ['Date'] })` —
  Date only, so real `setTimeout` still delivers WebSocket frames.
- **Compat-date divergence is real**: `wrangler.jsonc` requests 2026-07-01 but the
  installed runtime caps at 2025-09-06, so `web_socket_auto_reply_to_close`
  (default 2026-04-07) is **off locally, on in production**.
- `evictDurableObject(stub, { webSockets: "close" })` — the documented way to test
  hibernate-across-eviction and reconnect — is **absent from 0.8.71** (latest
  published is 0.20.1). Bump the dependency *before* writing FR-017 tests, or
  accept that eviction behavior is untested locally.
- `runDurableObjectAlarm` returns `false` when a near-future alarm already
  self-fired (schedule far-future, then trigger explicitly), and
  `AlarmInvocationInfo.scheduledTime` came back `undefined` under the harness
  despite being in the types.

---

## 7. Event derivation and reconciliation

**Decision**: Derive events by **replaying the pick pointer one step at a time**
over the newly revealed span, guarded by a persisted per-turn mark set — never by
diffing a "current pick" pointer. Reduce every observation to
`(longest-common-prefix c, stored length m, observed length n)`:

- `c == m` → pure append: walk `m → n`, emitting each implied event in order.
- `c < m` → correction: list surgery, one non-retracting `draft_revised` event,
  clear marks above `c`, replay from `c`.
- `c == m == n` → no-op: empty walk, **zero** events (idempotency is structural).

This is what makes FR-020a fall out for free: a batch that reveals five picks
walks five steps and emits every implied `on_deck` / `on_the_clock`, in order,
exactly once.

**Sequence numbers**: a per-session `(epoch: uuid, seq: integer)` delivery
cursor, assigned inside the same `transactionSync` that appends picks, marks and
events. FR-014's "identical rebuilt state" is defined over an explicit
`stateFingerprint` that **excludes** epoch, seq, revision, observed_at and the
event log — a rebuild collapses N observations into one and provably cannot
reproduce the original stream. This is a deliberate, documented narrowing of
FR-014, not an oversight.

**Owner lookahead**: `teamAt(n)` = observed fact below the frontier, snake
projection above it, with a self-calibrating `orderTrust` tri-state that degrades
to `unknown` — baseline cadence, no turn events — rather than fabricating.

**Gotchas**:
- **Turn-boundary collapse is the normal case, not an edge case.** In a 12-team
  snake the slot-1 and slot-12 owners pick back-to-back at every round boundary
  (#24 then #25). There is *no state* in which the owner is 2 picks from #25 and
  not already on the clock for #24 — so `on_deck(25)` and `on_the_clock(25)`
  necessarily fire in the same step with zero lead time. This is precisely why
  `on_deck` carries the real `picks_until` (2, 1 or 0) and why SC-003 scopes its
  minimum-lead-time clause. **006 must pre-compute its second pick off
  `on_the_clock(T)`, not wait for `on_deck(T+1)`.**
- **A stale in-flight ESPN fetch can trigger a phantom undo**: a slow poll
  returning after a newer one presents a shorter list, which the reconciler reads
  as a commissioner undo — rolling back real picks. The `obsSeq > lastObsSeq`
  guard plus a single in-flight-promise gate are load-bearing correctness.
- Build rosters and the unavailable set as `picks ∪ pre-draft rostered` keyed by
  `playerId`, but derive the pick pointer, the LCP and every event **only** from
  `draftDetail.picks`.
- **Do not persist on a no-op observation.** The reason changed with the
  transport but the rule did not: under polling this avoided ~20 pointless
  commits per minute; under the tap it avoids committing on every 5 s safety-alarm
  sweep that finds the cursor already current, which is most of them during a
  slow round. Gate the transaction on
  `events.length > 0 || orderChanged || statusChanged`.
- **`observed_at` collapses on rebuild**: after a cold rebuild every pick carries
  one observation time, destroying the per-pick timing 008 wants. Mirror to D1
  first-seen-wins (`ON CONFLICT DO UPDATE` that never overwrites it).
- **Broadcast after the commit, never inside it.** A crash between commit and
  fan-out loses a push but not state, and the cursor hand-off recovers it.


## 8. Round 4: how the session is fed (2026-08-05)

Written after `010-draft-tap` shipped, was deployed, and fed two real drafts.
These resolve the questions that only became answerable once the transport
existed and could be measured.

### 8.1 Notify-then-pull, not push-through

**Decision**: `/api/tap/batch` writes to `tap_batches`, acknowledges, and *then*
nudges the `DraftSession` via `ctx.waitUntil`. The session pulls from the log by
keyset cursor. The nudge carries no frame data.

**Rationale**: The tap discards its buffer only on `accepted_through`, which
makes the ack a durability boundary. Acking before a durable write loses picks
the tap has already forgotten; acking after a DO round-trip lets a restarting or
migrating object stall the tap's buffer, which is exactly what FR-008's
buffering guarantees exist to prevent. Writing the log first and nudging after
satisfies both, and a dropped nudge then costs latency rather than data.

It also collapses two code paths into one. Round 3 already made the persisted
log the automatic rebuild path; if the live path reads the same log through the
same cursor, the recovery path is exercised on every pick rather than only after
a crash. The restore routine that only runs in emergencies is the one that rots.

**Alternatives considered**:

- **Pass frames inline in the nudge** — makes the DO's availability a durability
  dependency and reintroduces the exact failure the ack ordering was chosen to
  avoid.
- **Cloudflare Queues** — a second delivery system and a new binding, to move
  data that is already durably written to a table the feature must maintain
  regardless. Rejected under Constitution VIII.
- **DO alarm polls D1 with no nudge** — simple, but latency becomes the alarm
  interval. Meeting SC-001's p95 ≤ 2 s would need a ~1 s alarm, i.e. polling D1
  ~10,800 times per draft to carry ~72 picks.

**Cursor shape**: keyset on `(received_at, id)` over the existing
`idx_tap_batches_league`, not an offset and not "re-read and dedupe". An offset
window shifts under concurrent inserts; dedupe-on-re-read makes correctness
depend on the reducer's idempotency, which should be a safety net rather than
the mechanism.

**Safety alarm**: 5 s while the room is open. SC-001 promises 100% within 10 s,
so the ceiling is enforced by a timer rather than by assuming `waitUntil` always
runs. It performs a D1 read and no external request.

### 8.2 Liveness is a heartbeat, not silence

**Decision**: the tap emits a heartbeat every **15 s**; a **45 s** gap is a
lapse; a **15 s** alarm evaluates it.

**Rationale**: measured inter-pick gaps span ~1 s (autodraft) to 90 s+ (human
picks in the same league). No silence threshold separates a slow draft from a
dead tap, and both errors are bad: a false alarm during a slow round destroys
trust in the indicator, while a missed one is precisely the silent-failure mode
FR-017 exists to forbid. 45 s tolerates a single dropped request; 15 s detection
lands inside SC-001b's 30 s.

**Consequence for 010**: the tap currently reports only on state *change*, so a
healthy tap is silent — the exact case this check must observe. The periodic
heartbeat is a change in 010 (005 FR-007e), recorded in ROADMAP.

### 8.3 ESPN's post-completion flush is promoted to a production oracle

**Decision**: on `drafted`, fetch the authoritative `mDraftDetail` and reconcile
the tap-built draft against it before archiving; divergence bumps the revision
through the existing correction path.

**Rationale**: the single thing Gate 0 proved ESPN writes reliably is the
*completed* draft. 010 used exactly this as an independent oracle in tests,
where it earned its keep twice — it disproved the field-3 = round reading
(agreeing on 5 of 70 picks) and confirmed the ledger offsets (31/31). Promoting
it to production means every archived draft is checked against a source that did
not produce it, for one request per draft. Self-consistency checks cannot catch
a systematically missed pick; an independent source can.

### 8.4 What did not change

§1 (Durable Object as the session), §3 (WebSocket transport), §5 (storage split),
§6 (testing strategy) and §7 (event derivation and reconciliation) are unaffected
by the transport change and stand as written. §4 (`mDraftDetail`) narrows to
pre-draft reads, the `inProgress`/`drafted` flags, and the completion oracle.
