CREATE TABLE "notification_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_notification_queue_sent_at" ON "notification_queue" USING btree ("sent_at");