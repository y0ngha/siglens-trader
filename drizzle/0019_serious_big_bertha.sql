ALTER TABLE "positions" ADD COLUMN "stop_price" numeric;--> statement-breakpoint
UPDATE "analysis_model_config" SET "analysis_type" = 'entry_review' WHERE "analysis_type" = 'trade_gate';--> statement-breakpoint
DELETE FROM "analysis_model_config" WHERE "analysis_type" IN ('options', 'congress');--> statement-breakpoint
DELETE FROM "config" WHERE "key" IN ('buy_threshold', 'sell_threshold', 'score_weights', 'confluence_min', 'confluence_exit_min', 'confluence_span', 'confluence_expected_weight', 'confluence_htf', 'confluence_htf_mode', 'confluence_require_volume', 'min_rr', 'min_stop_room_pct', 'entry_window', 'entry_cooldown_min', 'fixed_exit_enabled', 'stop_loss_percent', 'take_profit_percent', 'analysis_timeframe');
