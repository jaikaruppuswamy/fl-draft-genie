-- Draft Genie 005-draft-monitor: session header + permanent archive.
--
-- Numbered 0008 because 010-draft-tap took 0006 (tap_pairings) and 0007
-- (tap_batches). tap_batches is the LIVE FEED this feature reads from — the
-- session pulls it by keyset cursor — so nothing here duplicates it.
--
-- THE CASCADE DECISION (research §5, FR-013) is the load-bearing part of this
-- file. `draft_sessions` is operational state and cascades from
-- `league_connections`: disconnecting a league should stop its session. The
-- ARCHIVE must not. It is season history, and the owner who disconnects a
-- league in March has not asked to erase their August draft. So every archive
-- table keys on `account_id` and cascades from `accounts`, with **no foreign
-- key to `league_connections` at all**.
--
-- That is also why `my_team_id`, `order_json` and `teams_json` live on
-- `draft_archives` rather than `draft_sessions`: putting them on the session
-- row would put them back on the cascade path and defeat the whole point.

-- Operational: the cron work-list, and the live session's D1-visible header.
CREATE TABLE draft_sessions (
  connection_id TEXT PRIMARY KEY REFERENCES league_connections (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  -- unsupported | idle | armed | live | not_receiving | degraded | complete | aborted
  status TEXT NOT NULL DEFAULT 'idle',
  -- Set when the tap first arms the session (FR-007g). NULL means never armed.
  armed_at TEXT,
  -- ESPN's scheduled draft time, used for the armed absolute deadline.
  scheduled_at TEXT,
  -- FR-007e: liveness comes from the tap's heartbeat, never from pick silence.
  -- `heartbeat_hidden` decides WHICH threshold applies: a background tab's
  -- timers throttle to ~1/minute, so one threshold would declare a healthy
  -- backgrounded tap dead — and the ratified design expects that tab to be
  -- backgrounded.
  last_heartbeat_at TEXT,
  heartbeat_hidden INTEGER NOT NULL DEFAULT 0,
  tap_state TEXT,
  tap_version TEXT,
  -- Keyset cursor into tap_batches. Advanced only AFTER the batch is committed
  -- to session state; advancing first would skip rows on a crash.
  feed_received_at TEXT,
  feed_id TEXT,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  -- The cron re-arms only where this is NULL and no alarm is set; without it a
  -- finished draft gets resumed every five minutes.
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_draft_sessions_worklist ON draft_sessions (archived_at, status);
CREATE INDEX idx_draft_sessions_account ON draft_sessions (account_id, season);

-- Permanent history. Retained INDEFINITELY (ratified 2026-08-02), matching
-- 002's retention of every season's projection sets, so 008's replay lab
-- inherits a real corpus.
CREATE TABLE draft_archives (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Plain columns, NO FK: this record must outlive a league disconnect.
  connection_id TEXT NOT NULL,
  espn_league_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  league_name TEXT,
  format TEXT NOT NULL DEFAULT 'snake',
  my_team_id INTEGER,
  team_count INTEGER NOT NULL,
  round_count INTEGER NOT NULL,
  order_json TEXT,
  teams_json TEXT,
  -- Did ESPN's post-completion flush agree with what the tap built? The one
  -- thing Gate 0 proved ESPN writes reliably is the COMPLETED draft, so it is
  -- an independent oracle — it disproved the field-3 reading (5/70) and
  -- confirmed the ledger offsets (31/31) during 010. Divergence is RECORDED,
  -- not silently resolved in favour of either side.
  oracle_checked_at TEXT,
  oracle_divergence_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_draft_archives_account ON draft_archives (account_id, season, completed_at);
CREATE UNIQUE INDEX idx_draft_archives_league_season ON draft_archives (account_id, espn_league_id, season);

CREATE TABLE draft_picks (
  archive_id TEXT NOT NULL REFERENCES draft_archives (id) ON DELETE CASCADE,
  overall INTEGER NOT NULL,
  round INTEGER NOT NULL,
  round_pick INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  -- NEVER filtered on sign. `-1` is the empty-slot sentinel; D/ST player ids
  -- are legitimately negative, around -16000. `playerId > 0` is what made
  -- 010's capture script report 66 of 72 picks for a complete draft.
  player_id INTEGER NOT NULL,
  keeper INTEGER NOT NULL DEFAULT 0,
  autodrafted INTEGER NOT NULL DEFAULT 0,
  -- FIRST-SEEN-WINS on write. After a cold rebuild every pick otherwise
  -- carries one observation time, destroying the per-pick timing 008 needs.
  observed_at TEXT,
  -- Comparable only WITHIN one epoch: the tap re-anchors its clock across
  -- sleep, so stamps from different epochs are not one timeline.
  observed_epoch INTEGER,
  PRIMARY KEY (archive_id, overall)
);

CREATE INDEX idx_draft_picks_player ON draft_picks (archive_id, player_id);

CREATE TABLE draft_keepers (
  archive_id TEXT NOT NULL REFERENCES draft_archives (id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  PRIMARY KEY (archive_id, team_id, player_id)
);
