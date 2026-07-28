-- Repository deletion is a generation-fenced, recoverable lifecycle.
--
-- The repository row reserves its owner/name while old requests drain. R2 refs
-- are replaced by a tombstone and a generation-specific quarantine marker.
-- Physical object cleanup happens later; only then is the repository row removed.
ALTER TABLE repositories ADD COLUMN generation TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE repositories ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active';

-- Existing repository ids are already unique and immutable, so they are a safe
-- initial generation fence.
UPDATE repositories SET generation = id WHERE generation = 'legacy';

CREATE TABLE IF NOT EXISTS repository_deletions (
  generation      TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL UNIQUE,
  storage_key     TEXT NOT NULL,
  quarantine_key  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  not_before      INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_repository_deletions_due
  ON repository_deletions(status, not_before);
CREATE INDEX IF NOT EXISTS idx_repositories_lifecycle
  ON repositories(lifecycle_state, updated_at);
