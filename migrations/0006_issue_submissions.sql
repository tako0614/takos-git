-- Repo/principal lifetime bounds the creation receipt. Issue removal must not
-- erase it and turn an uncertain retry into another allocation.
-- Title/body and the raw request key are not retained. Metadata records the
-- original creation projection so write-only callers cannot read later edits.
CREATE TABLE IF NOT EXISTS issue_submissions (
  repo_id            TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  principal_id       TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key_hash           TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  issue_id           TEXT NOT NULL UNIQUE,
  issue_number       INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  creation_metadata  TEXT NOT NULL,
  PRIMARY KEY (repo_id, principal_id, key_hash)
);
