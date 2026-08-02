-- Draft Genie 002-projections-pipeline (see specs/002-projections-pipeline/data-model.md)
-- Global data: no account/league foreign keys (FR-007).

CREATE TABLE pro_teams (
  espn_team_id INTEGER PRIMARY KEY,
  abbrev TEXT NOT NULL,
  name TEXT NOT NULL,
  bye_week INTEGER
);

CREATE TABLE players (
  espn_player_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  primary_position TEXT NOT NULL,
  eligible_positions TEXT NOT NULL, -- JSON array of position strings
  pro_team_id INTEGER NOT NULL,     -- 0 = free agent
  active INTEGER NOT NULL,          -- 0/1 (FR-003)
  injury_status TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_players_active ON players (active);

CREATE TABLE projection_sets (
  id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'complete')),
  -- 'trigger' is an SQLite keyword; trigger_kind carries the contract's "trigger" value.
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'on_demand', 'draft_day')),
  fetched_at TEXT NOT NULL,
  player_count INTEGER
);
CREATE INDEX idx_sets_season_status ON projection_sets (season, status, fetched_at);

CREATE TABLE player_projections (
  set_id TEXT NOT NULL REFERENCES projection_sets (id) ON DELETE CASCADE,
  espn_player_id INTEGER NOT NULL,
  stats_json TEXT NOT NULL, -- lossless statId -> projected amount (FR-004)
  adp REAL,
  overall_rank INTEGER,
  PRIMARY KEY (set_id, espn_player_id)
);
