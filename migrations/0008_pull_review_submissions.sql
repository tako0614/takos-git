-- Preserve the original review's receipt across review/PR deletion while its
-- backing Issue and principal still exist. No raw key or review body is copied.
CREATE TABLE IF NOT EXISTS pull_review_submissions (
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  pr_id         TEXT NOT NULL,
  review_id     TEXT NOT NULL UNIQUE,
  commit_sha    TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (issue_id, principal_id, key_hash)
);
