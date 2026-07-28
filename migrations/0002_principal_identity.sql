-- Principal identity must include the trusted issuer. Interface automation is
-- additionally bound to the exact InterfaceBinding that authorized it.
--
-- Existing 0001 rows use the empty issuer/binding sentinel. The first
-- authenticated request for that legacy subject adopts the row in
-- `upsertPrincipal`, preserving grants without letting a second issuer or
-- binding inherit them.
ALTER TABLE principals ADD COLUMN issuer TEXT NOT NULL DEFAULT '';
ALTER TABLE principals ADD COLUMN binding_id TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS uq_principals_subject;
CREATE UNIQUE INDEX IF NOT EXISTS uq_principals_identity
  ON principals(issuer, subject, binding_id);
CREATE INDEX IF NOT EXISTS idx_principals_subject
  ON principals(subject);
