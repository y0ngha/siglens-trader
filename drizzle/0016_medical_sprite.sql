ALTER TABLE "trade_audit" ADD COLUMN "correlation_id" text;--> statement-breakpoint
CREATE INDEX "idx_trade_audit_created" ON "trade_audit" USING btree ("created_at");