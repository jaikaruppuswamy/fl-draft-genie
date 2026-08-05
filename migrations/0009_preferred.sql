-- Draft Genie 006-recommendation-engine: the owner's preferred-player list.
--
-- THE CASCADE HERE IS DELIBERATELY THE OPPOSITE OF `draft_archives`.
--
-- 005 gave the archive NO foreign key to `league_connections` at all, because
-- an August draft is season history and the owner who disconnects a league in
-- March has not asked to erase it.
--
-- A preferred list is not history. It is live intent about a league the owner
-- is currently in: "these are the players I want this year". Disconnect the
-- league and it means nothing. So it cascades from BOTH the connection and the
-- account, and goes when either does.
--
-- `account_id` is carried even though it is derivable through `connection_id`,
-- so that FR-020's isolation can be enforced IN THE QUERY rather than by a
-- comparison at a call site that someone can forget. Same reasoning as
-- `tap_batches`, and the same reason `readBatchesAfter` takes a scope.
--
-- There is NO foreign key to `players`. A preferred player may be released or
-- retired and drop off the board entirely (FR-021); the row survives and the
-- page explains why the player cannot be used. A foreign key would let the
-- board's nightly refresh delete the owner's intent behind their back.

CREATE TABLE preferred_players (
  connection_id TEXT NOT NULL REFERENCES league_connections (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  -- NEVER filtered on sign. D/ST player ids are legitimately negative, around
  -- -16000; `playerId > 0` is what made 010's capture script report 66 of 72
  -- picks for a complete draft.
  espn_player_id INTEGER NOT NULL,
  -- The deterministic tiebreak where one is needed (FR-017).
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, season, espn_player_id)
);

CREATE INDEX idx_preferred_account ON preferred_players (account_id, season);
