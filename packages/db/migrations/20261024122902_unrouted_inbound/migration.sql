CREATE TABLE "unrouted_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_message_id" text NOT NULL UNIQUE,
	"from_email" text NOT NULL,
	"subject" text,
	"body_text" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
