-- What somebody told us, and where they were standing when they said it.
--
-- `user_id` is NULLABLE, which is the one thing that makes this table
-- different from every other one here. A visitor who bounced off the landing
-- page is the person whose reason nobody ever learns, and a form behind a
-- sign-in cannot hear from them. A row that DOES belong to somebody leaves
-- with their account, screenshots and all, by the cascade below.
--
-- Nothing is auto-captured from their work: the page URL, the window size, the
-- browser string and the build. Not the console log, which every in-app
-- feedback guide recommends capturing and which in this app can quote a
-- bullet — the same rule as lib/failures.ts/sanitise.
CREATE TABLE IF NOT EXISTS "feedback" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text,
  "application_id" text,
  "kind" text NOT NULL,
  "message" text NOT NULL,
  "email" text,
  "page_url" text,
  "user_agent" text,
  "viewport" text,
  "app_version" text,
  "attempt_id" bigint,
  "sender" text,
  "seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The screenshots, in their own table so the inbox query stays small.
--
-- In the database rather than in a bucket, and both reasons are about tonight.
-- The app holds no storage credentials — it talks to Postgres and nothing else
-- — so a bucket is a credential and a deploy variable before it is a feature.
-- And an image in a row leaves with the account by the same cascade as
-- everything else, where a bucket needs its own deletion path that has to be
-- remembered in deleteUserData forever. Images are shrunk in the browser
-- before they are sent, so a row is a few hundred kilobytes.
CREATE TABLE IF NOT EXISTS "feedback_shots" (
  "id" text PRIMARY KEY NOT NULL,
  "feedback_id" text NOT NULL,
  "content_type" text NOT NULL,
  "bytes" bytea NOT NULL,
  "byte_size" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Deleting an account takes what they said with it, and their screenshots
-- after it. Two cascades in a chain, not one: feedback goes with the user, and
-- the images go with the feedback.
DO $$ BEGIN
  ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "feedback_shots" ADD CONSTRAINT "feedback_shots_feedback_id_feedback_id_fk"
    FOREIGN KEY ("feedback_id") REFERENCES "feedback"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- `set null`, not cascade: a report about an application somebody has since
-- deleted, or about an attempt that has aged out, is still a report worth
-- reading. Only the account deletion above is meant to remove the row itself.
DO $$ BEGIN
  ALTER TABLE "feedback" ADD CONSTRAINT "feedback_application_id_applications_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "feedback" ADD CONSTRAINT "feedback_attempt_id_failures_id_fk"
    FOREIGN KEY ("attempt_id") REFERENCES "failures"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- The inbox reads newest first; the rate limit counts one sender's last ten
-- minutes, and is the only query on the path a person waits for.
CREATE INDEX IF NOT EXISTS "feedback_recent_idx" ON "feedback" ("created_at");
CREATE INDEX IF NOT EXISTS "feedback_sender_idx" ON "feedback" ("sender","created_at");
CREATE INDEX IF NOT EXISTS "feedback_shots_of_idx" ON "feedback_shots" ("feedback_id");

-- Nothing but the server may read or write either of these.
--
-- Supabase exposes every table in `public` through PostgREST to the `anon` and
-- `authenticated` roles. These two carry other people's words and other
-- people's screenshots — the most sensitive pair of tables in the schema to
-- get wrong, because `anon` means anyone at all.
--
-- Row Level Security with NO policies is the whole mechanism: a role subject
-- to RLS and matched by no policy can do nothing. The app is unaffected
-- because it connects as the tables' owner, and an owner is not subject to RLS
-- unless FORCE is set — deliberately not set, because the server is the one
-- caller that must always work.
ALTER TABLE "feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feedback_shots" ENABLE ROW LEVEL SECURITY;

-- Belt and braces. RLS is the guarantee; these remove the grant Supabase's
-- default privileges hand the client roles on a new table, so the tables are
-- unreachable even if a policy is ever added by accident.
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE "feedback" FROM anon';
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE "feedback" FROM authenticated';
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE "feedback_shots" FROM anon';
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE "feedback_shots" FROM authenticated';
EXCEPTION WHEN undefined_object THEN null; END $$;
