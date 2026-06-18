ALTER TABLE "analysis_results" ADD COLUMN "source_analyzed_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "config" ("key", "value") VALUES
('trading_mode', '"dry_run"'::jsonb),
('trading_enabled', 'true'::jsonb),
('max_position_size', '5000'::jsonb),
('max_total_exposure', '25000'::jsonb),
('stop_loss_percent', '5'::jsonb),
('take_profit_percent', '10'::jsonb),
('buy_threshold', '70'::jsonb),
('sell_threshold', '30'::jsonb),
('analysis_timeframe', '"1Hour"'::jsonb),
('score_weights', '{"technical":8,"news":6,"options":5,"fundamental":4,"overall":3}'::jsonb),
('fixed_exit_enabled', 'false'::jsonb),
('max_trades_per_day', '20'::jsonb),
('max_daily_loss_usd', '500'::jsonb)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "config"
SET "value" = '"1Hour"'::jsonb, "updated_at" = now()
WHERE "key" = 'analysis_timeframe'
  AND "value" = '"1Day"'::jsonb;--> statement-breakpoint
INSERT INTO "analysis_model_config"
    ("analysis_type", "enabled", "model_id", "use_byok")
VALUES
    ('technical', true, 'gemini-2.5-flash', false),
    ('news', true, 'gemini-2.5-flash', false),
    ('options', true, 'gemini-2.5-flash', false),
    ('fundamental', true, 'gemini-2.5-flash', false),
    ('overall', true, 'gemini-2.5-flash', false)
ON CONFLICT ("analysis_type") DO NOTHING;