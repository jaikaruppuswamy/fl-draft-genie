import { iso, uuid } from "./client";

export interface AccountRow {
  id: string;
  email: string;
  created_at: string;
  last_login_at: string | null;
}

export async function findAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return db
    .prepare("SELECT * FROM accounts WHERE email = ?")
    .bind(email.toLowerCase())
    .first<AccountRow>();
}

export async function findAccountById(db: D1Database, id: string): Promise<AccountRow | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
}

export async function createAccount(db: D1Database, email: string, now: Date): Promise<AccountRow> {
  const row: AccountRow = {
    id: uuid(),
    email: email.toLowerCase(),
    created_at: iso(now),
    last_login_at: iso(now),
  };
  await db
    .prepare("INSERT INTO accounts (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)")
    .bind(row.id, row.email, row.created_at, row.last_login_at)
    .run();
  return row;
}

export async function touchLogin(db: D1Database, accountId: string, now: Date): Promise<void> {
  await db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").bind(iso(now), accountId).run();
}

/** FR-009: cascades to credentials, connections, and snapshots via FK ON DELETE CASCADE. */
export async function deleteAccount(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId).run();
}
