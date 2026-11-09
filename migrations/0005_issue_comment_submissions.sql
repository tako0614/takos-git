-- Metadata-only receipts: parent Issue/principal removal retires the scope.
-- Do not reference issue_comments: deleting a comment must not erase its receipt
-- and allow a lost-response replay to resurrect it. No comment body/key is kept.
CREATE TABLE IF NOT EXISTS issue_comment_submissions (
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,
  body_hash     TEXT NOT NULL,
  comment_id    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (issue_id, principal_id, key_hash)
);
