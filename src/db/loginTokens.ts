import { iso, uuid } from "./client";

export interface LoginTokenRow {
  id: string;
  email: string;
  code_hash: string;
  link_hash: string;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export async function countOutstandingTokens(
  db: D1Database,
  email: string,
  now: Date,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND consumed_at IS NULL AND expires_at > ?",
    )
    .bind(email.toLowerCase(), iso(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertLoginToken(
  db: D1Database,
  email: string,
  codeHash: string,
  linkHash: string,
  expiresAt: Date,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO login_tokens (id, email, code_hash, link_hash, attempts, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, 0, ?, NULL, ?)",
    )
    .bind(uuid(), email.toLowerCase(), codeHash, linkHash, iso(expiresAt), iso(now))
    .run();
}

export async function findUsableTokensByEmail(
  db: D1Database,
  email: string,
  now: Date,
): Promise<LoginTokenRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM login_tokens WHERE email = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 5",
    )
    .bind(email.toLowerCase(), iso(now))
    .all<LoginTokenRow>();
  return res.results;
}

export async function findUsableTokenByLinkHash(
  db: D1Database,
  linkHash: string,
  now: Date,
): Promise<LoginTokenRow | null> {
  return db
    .prepare(
      "SELECT * FROM login_tokens WHERE link_hash = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 5",
    )
    .bind(linkHash, iso(now))
    .first<LoginTokenRow>();
}

export async function incrementAttempts(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE login_tokens SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
}

export async function consumeToken(db: D1Database, id: string, now: Date): Promise<void> {
  await db.prepare("UPDATE login_tokens SET consumed_at = ? WHERE id = ?").bind(iso(now), id).run();
}
