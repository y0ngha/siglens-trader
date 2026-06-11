CREATE TABLE "analysis_model_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"analysis_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"model_id" text NOT NULL,
	"use_byok" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_model_config_analysis_type_unique" UNIQUE("analysis_type")
);
--> statement-breakpoint
CREATE TABLE "analysis_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"analysis_type" text NOT NULL,
	"result" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL,
	"cron_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"target" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "notification_config_channel_unique" UNIQUE("channel")
);
--> statement-breakpoint
CREATE TABLE "pending_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" integer NOT NULL,
	"price_limit" numeric,
	"analysis_summary" text,
	"signal_score" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" integer NOT NULL,
	"avg_price" numeric NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_price" numeric,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"order_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" numeric NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"reason" text,
	"mode" text NOT NULL,
	"cron_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"company_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_symbol_unique" UNIQUE("symbol")
);
