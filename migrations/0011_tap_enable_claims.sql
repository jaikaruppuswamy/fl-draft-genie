-- 011 US3 — the one-click enablement handshake.
--
-- Replaces "copy this token from the page, paste it into a prompt() on ESPN".
-- That flow rendered a 180-day bearer into the DOM, where any same-origin script
-- could read it, and required the owner to handle a credential (FR-017 forbids
-- both).
--
-- The handshake is split so that neither half alone is enough:
--
--   * the PAGE creates the row, under session auth, in response to a real
--     click. It never learns a credential — it sends a HASH and gets back an
--     opaque handle.
--   * the SCRIPT redeems it, presenting the PREIMAGE the page never had. Only
--     the extension can complete it, and only the extension receives the token.
--
-- A claim is therefore useless to a page that steals it, and a nonce is useless
-- without a claim minted under someone's session.
--
-- Deliberately short-lived and single-use. This exists for the two seconds
-- between a click and a redeem; anything longer is a credential in waiting.
CREATE TABLE tap_enable_claims (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- sha256 of the nonce the userscript generated. The preimage is never stored,
  -- never sent to the page, and never leaves the extension.
  commit_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set by the redeem. The UPDATE is conditional on this being NULL, so two
  -- redeems of one claim cannot both mint — the same pattern `revokePairing`
  -- uses.
  consumed_at TEXT
);

-- The redeem looks a claim up by id; the claim insert clears an account's prior
-- unconsumed rows so a double-click cannot leave a pile of live claims.
CREATE INDEX idx_tap_enable_claims_account ON tap_enable_claims (account_id, consumed_at);
