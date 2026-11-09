-- PR creation receipts survive individual PR/Issue deletion; the enclosing
-- Repo/principal lifetime remains their authority boundary. No raw key or
-- title/body is duplicated. Metadata is the original creation projection.
CREATE TABLE IF NOT EXISTS pull_request_submissions (
  repo_id           TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  principal_id      TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key_hash          TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  pr_id             TEXT NOT NULL UNIQUE,
  issue_id          TEXT NOT NULL UNIQUE,
  pr_number         INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  creation_metadata TEXT NOT NULL,
  PRIMARY KEY (repo_id, principal_id, key_hash)
);
