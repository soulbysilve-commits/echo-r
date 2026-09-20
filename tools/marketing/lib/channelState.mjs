// Durable per-channel auth-check and canary results. Read by `status` so it
// never has to make a live network call just to report state — auth-check
// and canary are separate, explicit, human-triggered commands.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_state (
  channel                 TEXT PRIMARY KEY,
  auth_checked_at         TEXT,
  auth_valid              INTEGER,
  account_identifier      TEXT,
  permissions_sufficient  INTEGER,
  canary_checked_at       TEXT,
  canary_passed           INTEGER,
  canary_external_id      TEXT,
  canary_external_url     TEXT
);
`;

export function ensureChannelStateSchema(db) {
  db.exec(SCHEMA);
}

export function recordAuthCheck(db, channel, { authValid, accountIdentifier, permissionsSufficient }) {
  ensureChannelStateSchema(db);
  db.prepare(
    `INSERT INTO channel_state (channel, auth_checked_at, auth_valid, account_identifier, permissions_sufficient)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel) DO UPDATE SET
       auth_checked_at = excluded.auth_checked_at,
       auth_valid = excluded.auth_valid,
       account_identifier = excluded.account_identifier,
       permissions_sufficient = excluded.permissions_sufficient`
  ).run(channel, new Date().toISOString(), authValid ? 1 : 0, accountIdentifier ?? null, permissionsSufficient ? 1 : 0);
}

export function recordCanary(db, channel, { passed, externalId, externalUrl }) {
  ensureChannelStateSchema(db);
  // Ensure a row exists (canary can theoretically be checked before an explicit auth-check row exists).
  db.prepare('INSERT OR IGNORE INTO channel_state (channel) VALUES (?)').run(channel);
  db.prepare(
    `UPDATE channel_state SET canary_checked_at = ?, canary_passed = ?, canary_external_id = ?, canary_external_url = ?
     WHERE channel = ?`
  ).run(new Date().toISOString(), passed ? 1 : 0, externalId ?? null, externalUrl ?? null, channel);
}

export function getChannelState(db, channel) {
  ensureChannelStateSchema(db);
  return db.prepare('SELECT * FROM channel_state WHERE channel = ?').get(channel) ?? {
    channel, auth_checked_at: null, auth_valid: 0, account_identifier: null, permissions_sufficient: 0,
    canary_checked_at: null, canary_passed: 0, canary_external_id: null, canary_external_url: null,
  };
}
