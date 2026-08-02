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
