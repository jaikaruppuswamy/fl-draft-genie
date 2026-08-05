-- Draft Genie 010-draft-tap: pairing credentials for the browser companion
-- (see specs/010-draft-tap/data-model.md).
--
-- The credential is PER USER; the league is carried per message and verified
-- against the account's own connections at ingest. That is how 005 FR-007d's
-- per-connection scoping and 010 FR-014's one-install-serves-all-leagues are
-- the same thing rather than a contradiction.
--
-- Blast radius if a token leaks: append draft messages for this account's own
-- leagues. It can never read league data and never reaches ESPN.

CREATE TABLE tap_pairings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The token itself is never stored, only its hash (001's credential pattern).
  token_hash TEXT NOT NULL UNIQUE,
  -- Bound on first use so one token is not silently shared across machines.
  install_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  -- FR-014a requires a stated lifetime rather than an indefinite credential.
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_tap_pairings_account ON tap_pairings (account_id);
