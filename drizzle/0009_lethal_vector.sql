CREATE TABLE "news_cards" (
	"news_id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"card" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_news_cards_symbol_created" ON "news_cards" USING btree ("symbol","created_at");