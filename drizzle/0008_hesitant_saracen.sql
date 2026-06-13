CREATE INDEX IF NOT EXISTS "idx_analysis_symbol_type_date" ON "analysis_results" USING btree ("symbol","analysis_type","analyzed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_orders_status" ON "pending_orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_positions_symbol_status" ON "positions" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trades_executed_at" ON "trades" USING btree ("executed_at");