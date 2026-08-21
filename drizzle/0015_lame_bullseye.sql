CREATE TABLE "trade_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"model_id" text NOT NULL,
	"system_prompt" text NOT NULL,
	"user_prompt" text NOT NULL,
	"raw_response" text,
	"status" text NOT NULL,
	"gate_error" text,
	"fraction" numeric,
	"confidence" integer,
	"cron_run_id" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_audit" ADD CONSTRAINT "trade_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_trade_audit_run_symbol" ON "trade_audit" USING btree ("cron_run_id","symbol");--> statement-breakpoint
CREATE INDEX "idx_trade_audit_symbol_created" ON "trade_audit" USING btree ("symbol","created_at");