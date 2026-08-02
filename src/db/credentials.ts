import { iso } from "./client";

export interface CredentialRow {
  account_id: string;
  s2_ciphertext: string;
  swid_ciphertext: string;
  swid_masked: string;
  status: "working" | "failing";
  last_validated_at: string | null;
  updated_at: string;
}

export async function getCredentials(db: D1Database, accountId: string): Promise<CredentialRow | null> {
  return db
    .prepare("SELECT * FROM espn_credentials WHERE account_id = ?")
    .bind(accountId)
    .first<CredentialRow>();
}

export async function upsertCredentials(
  db: D1Database,
  accountId: string,
  s2Ciphertext: string,
  swidCiphertext: string,
  swidMasked: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO espn_credentials (account_id, s2_ciphertext, swid_ciphertext, swid_masked, status, last_validated_at, updated_at)
       VALUES (?, ?, ?, ?, 'working', ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET
         s2_ciphertext = excluded.s2_ciphertext,
         swid_ciphertext = excluded.swid_ciphertext,
         swid_masked = excluded.swid_masked,
         status = 'working',
         last_validated_at = excluded.last_validated_at,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, s2Ciphertext, swidCiphertext, swidMasked, iso(now), iso(now))
    .run();
}

/** State machine (data-model.md): working→failing on ESPN 401/403; failing→working on successful validation. */
export async function setCredentialStatus(
  db: D1Database,
  accountId: string,
  status: "working" | "failing",
  now: Date,
): Promise<void> {
  if (status === "working") {
    await db
      .prepare("UPDATE espn_credentials SET status = 'working', last_validated_at = ?, updated_at = ? WHERE account_id = ?")
      .bind(iso(now), iso(now), accountId)
      .run();
  } else {
    await db
      .prepare("UPDATE espn_credentials SET status = 'failing', updated_at = ? WHERE account_id = ?")
      .bind(iso(now), accountId)
      .run();
  }
}
