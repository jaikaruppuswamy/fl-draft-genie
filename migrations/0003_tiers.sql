-- Draft Genie 003-board-refinements: Boris Chen positional tiers (global data).
CREATE TABLE tier_entries (
  format TEXT NOT NULL,     -- 'ppr' | 'half' | 'std' | 'all' (QB/K/DST are format-independent)
  position TEXT NOT NULL,   -- QB/RB/WR/TE/K/DST
  tier INTEGER NOT NULL,
  name_norm TEXT NOT NULL,  -- normalized player name (see src/tiers/borischen.ts)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (format, position, name_norm)
);
