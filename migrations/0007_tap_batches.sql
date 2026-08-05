-- Draft Genie 010-draft-tap: retained relay batches.
--
-- The ingest previously validated, authorised, acknowledged — and kept nothing.
-- A full live draft therefore relayed correctly and left no corpus behind,
-- because persistence was assigned to 005 and 005 is blocked on this feature.
-- This table closes that gap: every accepted batch is kept so a draft is
-- captured automatically, with no action required from the user.
--
-- Contents are already privacy-filtered by the tap (numeric ids only) and the
-- ingest re-asserts that before writing (FR-006a enforced at the boundary, not
-- only at the source).

CREATE TABLE tap_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Plain column, no FK: the retained record must outlive a league disconnect,
  -- exactly as 005's archive does (005 data-model.md cascade decision).
  connection_id TEXT NOT NULL,
  espn_league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  kinds TEXT NOT NULL,
  messages_json TEXT NOT NULL
);

CREATE INDEX idx_tap_batches_league ON tap_batches (account_id, espn_league_id, season, received_at);
CREATE INDEX idx_tap_batches_session ON tap_batches (install_id, session_id, first_seq);
