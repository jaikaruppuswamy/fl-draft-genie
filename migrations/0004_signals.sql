-- Draft Genie 004-context-signals: team-level signals in one uniform shape.
-- New kinds are data (CHECK extension), not schema (FR-006).
CREATE TABLE signal_entries (
  kind TEXT NOT NULL CHECK (kind IN ('offense', 'sos', 'oline')),
  pro_team_id INTEGER NOT NULL,
  raw_value REAL NOT NULL,
  score REAL NOT NULL,      -- 0-100, 100 = favorable end (research S3)
  rank INTEGER NOT NULL,    -- 1-32, 1 = favorable end; ties broken by team id
  provenance TEXT NOT NULL, -- 'derived:projections@<ts>' | 'curated:PFF@<date>'
  computed_at TEXT NOT NULL,
  PRIMARY KEY (kind, pro_team_id)
);
