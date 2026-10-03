-- Link sharing: one active read-only link per skill (like "anyone with the link" in Google Docs).
CREATE TABLE skill_shares (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX skill_shares_active_idx ON skill_shares(skill_id) WHERE revoked_at IS NULL;
