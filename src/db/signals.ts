export type SignalKind = "offense" | "sos" | "oline";

export interface SignalValue {
  raw_value: number;
  score: number;
  rank: number;
  provenance: string;
  computed_at: string;
}

const CHUNK = 14; // 7 params/row -> under D1's 100-param ceiling

/** Per-kind atomic replace: delete + inserts in one transactional batch (FR-008). */
export async function replaceSignalKind(
  db: D1Database,
  kind: SignalKind,
  entries: (SignalValue & { pro_team_id: number })[],
): Promise<void> {
  const statements = [db.prepare("DELETE FROM signal_entries WHERE kind = ?").bind(kind)];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT INTO signal_entries (kind, pro_team_id, raw_value, score, rank, provenance, computed_at) VALUES ${values}`,
        )
        .bind(
          ...chunk.flatMap((e) => [kind, e.pro_team_id, e.raw_value, e.score, e.rank, e.provenance, e.computed_at]),
        ),
    );
  }
  await db.batch(statements);
}

/** Kind-agnostic read: every kind exposes the identical shape (FR-005/006). */
export async function getSignalMaps(db: D1Database): Promise<Map<string, Map<number, SignalValue>>> {
  const res = await db
    .prepare("SELECT kind, pro_team_id, raw_value, score, rank, provenance, computed_at FROM signal_entries")
    .all<SignalValue & { kind: string; pro_team_id: number }>();
  const out = new Map<string, Map<number, SignalValue>>();
  for (const row of res.results) {
    if (!out.has(row.kind)) out.set(row.kind, new Map());
    out.get(row.kind)!.set(row.pro_team_id, {
      raw_value: row.raw_value,
      score: row.score,
      rank: row.rank,
      provenance: row.provenance,
      computed_at: row.computed_at,
    });
  }
  return out;
}

export async function signalsTableEmpty(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM signal_entries").first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}
