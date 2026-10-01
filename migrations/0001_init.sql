-- skillbox on D1. Same tables as the Postgres schema, adapted to SQLite:
-- JSON in TEXT, ISO-8601 timestamps in TEXT, booleans as 0/1, UUIDs from code.
-- Revision and proposal file bytes are not here: they are R2 objects files/<sha256>,
-- the rows hold a manifest [{path, sha256, size, executable, mime}].

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  reference_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'skill',
  members TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  replacement TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  icon TEXT,
  package_metrics TEXT,
  revision TEXT NOT NULL,
  search_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  metadata TEXT NOT NULL,
  files TEXT NOT NULL,
  source TEXT,
  checksum TEXT NOT NULL,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX revisions_skill_idx ON revisions(skill_id);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  all_skills INTEGER NOT NULL DEFAULT 0,
  skill_ids TEXT NOT NULL DEFAULT '[]',
  permissions TEXT NOT NULL,
  version TEXT NOT NULL
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'reader',
  all_skills INTEGER NOT NULL DEFAULT 0,
  skill_ids TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id)
);
-- Replaces the advisory lock around client names: one active client per name.
CREATE UNIQUE INDEX clients_active_name_idx ON clients(name_key) WHERE active = 1;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  expected_revision TEXT NOT NULL,
  files TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer TEXT,
  published_revision TEXT
);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  skill_id TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX events_skill_access_idx ON events(skill_id, created_at DESC)
  WHERE operation IN ('load', 'read_file', 'bundle', 'reported_use');
CREATE INDEX events_client_idx ON events(client_id, created_at);

CREATE TABLE workspace_settings (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Full-text search over skills.search_text. porter stems English words;
-- unicode61 tokenizes Cyrillic and other scripts (no stemming there; the
-- app adds prefix matching). Kept in sync by triggers on every skill write.
CREATE VIRTUAL TABLE skills_fts USING fts5(
  id UNINDEXED,
  search_text,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER skills_fts_insert AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(id, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER skills_fts_update AFTER UPDATE OF search_text ON skills BEGIN
  DELETE FROM skills_fts WHERE id = old.id;
  INSERT INTO skills_fts(id, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER skills_fts_delete AFTER DELETE ON skills BEGIN
  DELETE FROM skills_fts WHERE id = old.id;
END;
