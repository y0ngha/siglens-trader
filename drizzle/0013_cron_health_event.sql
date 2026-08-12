-- Opt existing notification rows into the new `cron_health` event.
--
-- The dashboard renders one checkbox per event key and stores the selected keys in
-- `notification_config.events`. A newly added key is absent from existing rows, so
-- without this backfill the "시스템 이상 감지" toggle would ship switched off and the
-- alert would silently never fire — the exact blind spot it exists to close.
--
-- Only rows that already have email enabled are touched: a channel the operator
-- turned off must stay off.
UPDATE "notification_config"
SET "events" = array_append("events", 'cron_health')
WHERE "enabled" = true
  AND NOT ('cron_health' = ANY("events"));
