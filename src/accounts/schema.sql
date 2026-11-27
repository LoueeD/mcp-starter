CREATE TABLE IF NOT EXISTS account (
  slot INTEGER PRIMARY KEY CHECK(slot = 1),
  id TEXT NOT NULL UNIQUE CHECK(length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 50),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 1366),
  public_key BLOB NOT NULL CHECK(typeof(public_key) = 'blob' AND length(public_key) BETWEEN 1 AND 4096),
  counter INTEGER NOT NULL CHECK(counter BETWEEN 0 AND 4294967295),
  transports TEXT NOT NULL CHECK(json_valid(transports) AND json_type(transports) = 'array'),
  device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK(backed_up IN (0, 1) AND (backed_up = 0 OR device_type = 'multiDevice')),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 50),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at AND expires_at <= created_at + 1800000)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS used_challenges (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash) = 64 AND hash NOT GLOB '*[^a-f0-9]*'),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS used_challenges_expiry ON used_challenges(expires_at);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
  app_credential_ciphertext TEXT,
  execution_token_hash TEXT UNIQUE CHECK(execution_token_hash IS NULL OR
    (length(execution_token_hash) = 64 AND execution_token_hash NOT GLOB '*[^a-f0-9]*')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  rotated_at INTEGER,
  revoked_at INTEGER,
  CHECK((status = 'active' AND app_credential_ciphertext IS NOT NULL AND execution_token_hash IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND app_credential_ciphertext IS NULL AND execution_token_hash IS NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS connections_order ON connections(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS connection_policy (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id),
  document TEXT NOT NULL CHECK(length(document) <= 65536)
);

-- Demo application data. Replace or remove this table with your own app.
CREATE TABLE IF NOT EXISTS demo_notes (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 20000),
  status TEXT NOT NULL CHECK(status IN ('open', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS demo_notes_order ON demo_notes(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS schema_version (
  slot INTEGER PRIMARY KEY CHECK(slot = 1),
  version INTEGER NOT NULL CHECK(version = 1)
);
INSERT OR IGNORE INTO schema_version (slot, version) VALUES (1, 1);
