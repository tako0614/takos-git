-- Durable webhook outbox.
--
-- Delivery intent and the payload R2 digest are committed before any network
-- request. A short lease lets concurrent fetch/scheduled invocations drain the
-- same table without duplicate concurrent sends; an expired lease is recoverable
-- after an isolate crash. Webhooks are intentionally at-least-once.
ALTER TABLE webhook_deliveries ADD COLUMN payload_sha256 TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN lease_until INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN updated_at INTEGER;

UPDATE webhook_deliveries
SET
  next_attempt_at = CASE
    WHEN status IN ('pending', 'failed') AND attempt < 5
      THEN created_at
    ELSE NULL
  END,
  updated_at = COALESCE(delivered_at, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at, lease_until);
