-- 011 US8 — remembering what ESPN itself said, so a reset is a CHANGE and not a
-- disagreement.
--
-- The snapshot cannot carry this. `recordSyncSuccess` upserts a single row with
-- no history, so comparing a fresh report against `draft_json.completed` races
-- its own writer — and any sync that declined to void would consume the
-- evidence, making the transition unobservable forever after.
--
-- `espn_draft_completed_at` is MONOTONIC: set the first time ESPN reports the
-- draft complete, never cleared by a sync, cleared only by a confirmed void. It
-- is also the selector for the post-draft watch, because a reset clears ESPN's
-- draft date and `draft_at` is therefore an absorbing state that can never
-- bring the league back into the pre-draft scan.
--
-- Why it must exist at all: a capture of a draft that is RUNNING reads
-- `drafted: false` with a full skeleton and zero filled picks — identical to a
-- post-reset body on every field but `inProgress`. Memory is what tells them
-- apart, and without it the detection voids live drafts.
ALTER TABLE league_snapshots ADD COLUMN espn_draft_completed_at TEXT;

-- One qualifying observation raises a suspicion; a later one confirms it. A
-- single read has voided nothing, which is why the gate needed three reads
-- before it would call a report unambiguous.
ALTER TABLE league_snapshots ADD COLUMN espn_reset_suspected_at TEXT;

CREATE INDEX idx_snapshots_espn_completed ON league_snapshots (espn_draft_completed_at);
