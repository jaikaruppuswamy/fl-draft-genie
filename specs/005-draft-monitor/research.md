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

## 2. Poll cadence: one self-rescheduling alarm

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
- **Do not persist on a no-op observation** — at the 3 s tier that is 20 pointless
  commits per minute per league. Gate the transaction on
  `events.length > 0 || orderChanged || statusChanged`.
- **`observed_at` collapses on rebuild**: after a cold rebuild every pick carries
  one observation time, destroying the per-pick timing 008 wants. Mirror to D1
  first-seen-wins (`ON CONFLICT DO UPDATE` that never overwrites it).
- **Broadcast after the commit, never inside it.** A crash between commit and
  fan-out loses a push but not state, and the cursor hand-off recovers it.
