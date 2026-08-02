export interface TierEntry {
  name_norm: string;
  tier: number;
}

const CHUNK = 19; // 5 params/row → under D1's 100-param ceiling

/** Per-(format,position) atomic replace (spec 003 FR-002). */
export async function replaceTierFeed(
  db: D1Database,
  format: string,
  position: string,
  entries: TierEntry[],
  now: Date,
): Promise<void> {
  const statements = [
    db.prepare("DELETE FROM tier_entries WHERE format = ? AND position = ?").bind(format, position),
  ];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO tier_entries (format, position, tier, name_norm, fetched_at) VALUES ${values}`,
        )
        .bind(...chunk.flatMap((e) => [format, position, e.tier, e.name_norm, now.toISOString()])),
    );
  }
  await db.batch(statements);
}

/**
 * Tier lookup for one league format: "POS:name_norm" → tier. Includes the
 * format-independent 'all' rows (QB/K/DST).
 */
export async function getTierMap(db: D1Database, format: string): Promise<Map<string, number>> {
  const res = await db
    .prepare("SELECT position, name_norm, tier FROM tier_entries WHERE format IN (?, 'all')")
    .bind(format)
    .all<{ position: string; name_norm: string; tier: number }>();
  return new Map(res.results.map((r) => [`${r.position}:${r.name_norm}`, r.tier]));
}

export async function tierTableEmpty(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM tier_entries").first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}
