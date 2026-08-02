-- Draft Genie 001-league-onboarding initial schema (see specs/001-league-onboarding/data-model.md)

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE login_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_login_tokens_email ON login_tokens (email);
CREATE INDEX idx_login_tokens_link ON login_tokens (link_hash);

CREATE TABLE espn_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  s2_ciphertext TEXT NOT NULL,
  swid_ciphertext TEXT NOT NULL,
  swid_masked TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('working', 'failing')),
  last_validated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE league_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  espn_league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  my_team_id INTEGER NOT NULL,
  team_match_source TEXT NOT NULL CHECK (team_match_source IN ('auto', 'manual')),
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT NOT NULL CHECK (last_sync_status IN ('ok', 'failed', 'pending')),
  UNIQUE (account_id, espn_league_id, season)
);
CREATE INDEX idx_connections_account ON league_connections (account_id);

CREATE TABLE league_snapshots (
  connection_id TEXT PRIMARY KEY REFERENCES league_connections (id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  league_name TEXT NOT NULL,
  team_count INTEGER NOT NULL,
  scoring_json TEXT NOT NULL,
  roster_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  teams_json TEXT NOT NULL,
  -- Duplicated from draft_json.scheduled_at for the indexed pre-draft cron scan (FR-019).
  draft_at TEXT
);
CREATE INDEX idx_snapshots_draft_at ON league_snapshots (draft_at);
