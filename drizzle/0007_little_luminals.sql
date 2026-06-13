CREATE TABLE IF NOT EXISTS "cron_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"cron_type" text NOT NULL,
	"symbol" text,
	"action" text NOT NULL,
	"executed" boolean DEFAULT false NOT NULL,
	"score" numeric,
	"reason" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cron_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"cron_type" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"summary" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cron_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cron_decisions_run" ON "cron_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cron_decisions_symbol_created" ON "cron_decisions" USING btree ("symbol","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cron_runs_type_started" ON "cron_runs" USING btree ("cron_type","started_at");