CREATE TABLE IF NOT EXISTS "order_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" integer NOT NULL,
	"toss_order_id" text,
	"status" text NOT NULL,
	"filled_price" numeric,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"cron_run_id" text,
	CONSTRAINT "order_tracking_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_positions_symbol_open" ON "positions" USING btree ("symbol") WHERE status = 'open';