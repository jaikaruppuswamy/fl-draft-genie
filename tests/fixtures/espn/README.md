# ESPN fixtures

Sanitized ESPN fantasy v3 league responses (views mSettings+mTeam+mDraftDetail
merged, exactly as the API returns them for a combined-view request).

These files were authored to the documented v3 response shape. To re-record
from a real league (recommended once per season — ESPN drifts):

1. Sign in at fantasy.espn.com; copy your `espn_s2` and `SWID` cookies.
2. `curl -H "Cookie: espn_s2=...; SWID={...}" \
   "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<YEAR>/segments/0/leagues/<LEAGUE_ID>?view=mSettings&view=mTeam&view=mDraftDetail" | jq . > settings-team.json`
3. Sanitize before committing: replace every member GUID, real name, display
   name, and league/team name with placeholder values. Never commit real
   SWIDs or any espn_s2 value.

## Placeholder derivation (feature 005)

Captures taken by `scripts/capture-draft.ts` are sanitized **on write** using a
mapping that is **deterministically derived and never persisted** — recomputing
it from the same league yields the same placeholders, so no lookup table of
real GUIDs exists to be committed.

Teams sort by ESPN `teamId` ascending and take index *n* = 1..N:

| Real value | Placeholder |
|---|---|
| owner GUID of team *n* | `{00000000-0000-4000-8000-0000000000NN}` (*n*, zero-padded to 12) |
| owner GUID of **my** team | `{11111111-2222-3333-4444-555555555555}` |
| `displayName` | `Manager n` |
| `firstName` / `lastName` | `Manager` / `n` |
| team `name` / `abbrev` | `Team n` / `Tn` |
| league `settings.name` | `Test League` |
| any other GUID-shaped string | `{00000000-0000-4000-8000-9000000000NN}` |

A member owning several teams takes the lowest index. Any GUID the derivation
does not recognise is still scrubbed — the sanitizer deep-walks every string in
the document rather than scrubbing named fields, because ESPN ships fields we
do not model. `assertClean()` runs before any write and throws if a real GUID,
a real name, or a credential value survives.

**Fabricated-GUID convention.** Beyond the derived set above, fixtures authored
by hand use GUIDs whose every group is one repeated hex character —
`{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}`, `{BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF}`,
`{CCCCCCCC-DDDD-EEEE-FFFF-000000000000}` and so on. No real SWID looks like
that, which is what makes the convention checkable rather than a matter of
trust. `scripts/privacy-sweep.ts` enforces it across the whole repo.

**The valid placeholder set is therefore a pattern, not a list**:
`/^\{?(00000000-0000-4000-8000-\d{12}|11111111-2222-3333-4444-555555555555)\}?$/`.
That regex is what the fixture gate and `tests/draft/no-secrets.test.ts` check.

**Member names are enumerated, not patterned.** Real first/last names and ESPN
handles once shipped in two committed fixtures: the sweep only checked GUID
shapes, so it reported clean over a `members[]` array full of them. It now
extracts every name inside a `members[]` array — at any nesting depth, including
through the JSON-in-a-string encoding used by captured XHR bodies — and requires
each to be either a derived placeholder (`Manager n` / `Manager` / `n`) or a
member of the hand-authored synthetic set in `scripts/privacy-sweep.ts`.

The check is deliberately scoped to `members[]`. The same ESPN payloads carry
`players[].firstName` for real NFL players, which the decode fixtures depend on;
a document-wide name check would either destroy those or be switched off.

Test identity: the suite's "my" SWID is `{11111111-2222-3333-4444-555555555555}`
(owns team 4 in `settings-team.json`, team 5 in `settings-team-half.json`, and
no team in `settings-odd.json` — that fixture drives the manual team-pick flow).
`draftdetail-published.json` is `settings-team.json` after ESPN publishes the
draft order (`pickOrder` filled).

## Projection fixtures (feature 002)

`kona-players.json` (kona_player_info shape: `players[].player` with
`stats[]` filtered to statSourceId=1/statSplitTypeId=0) and `proteams.json`
(proTeamSchedules_wl shape). All names/ids are fabricated; stat lines are
hand-authored so scoring oracles in tests/unit/scoring.test.ts stay valid —
if you re-record from the live public endpoints (below, NO cookies needed),
update the oracle expectations too.

```
curl "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<YEAR>/segments/0/leaguedefaults/3?view=kona_player_info" \
  -H 'X-Fantasy-Filter: {"players":{"limit":1500,"filterStatsForSourceIds":{"value":[1]}}}' | jq . > kona-players.json
curl "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<YEAR>?view=proTeamSchedules_wl" | jq . > proteams.json
```

Edge players baked in: `Rio Deuce` (RB/WR multi-position, projected in stat
198 that no fixture league scores), `Newt Longshot` (active, unprojected),
`Gus Hasbeen` (inactive — must be excluded from boards).
