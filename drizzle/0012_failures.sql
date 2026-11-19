-- Every attempt at the four things that can fail, and how each one ended.
--
-- Separate from usage_events on purpose: that table means "a model call
-- completed and was billed", which is what makes it a usable spend ledger.
-- This answers a different question — what happened to the person.
--
-- A row opens when an attempt STARTS. A request the platform kills runs no
-- catch block, so a row still showing finished_at NULL long afterwards is
-- the trace of exactly the failure that would otherwise leave none.
--
-- Nothing here carries the person's work: no bullet, no posting, no resume
-- text, not even inside an error message. See lib/failures.ts/sanitise.
CREATE TABLE IF NOT EXISTS "failures" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "application_id" text,
  "kind" text NOT NULL,
  "stage" text NOT NULL,
  "fault" text,
  "reason" text,
  "refunded" boolean DEFAULT false NOT NULL,
  "finished_at" timestamp with time zone,
  "ok" boolean,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Deleting an account takes its failure history with it. A record of what
-- went wrong for somebody who has left is still a record about them.
DO $$ BEGIN
  ALTER TABLE "failures" ADD CONSTRAINT "failures_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "failures" ADD CONSTRAINT "failures_application_id_applications_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "failures_user_idx" ON "failures" ("user_id","created_at");
-- For "what is failing lately", which reads across users.
CREATE INDEX IF NOT EXISTS "failures_recent_idx" ON "failures" ("created_at");

-- Nothing but the server may read or write this.
--
-- Supabase exposes every table in `public` through PostgREST to the `anon`
-- and `authenticated` roles. This table carries, per user, what they tried
-- and what broke — a thin record on its own and a map of somebody's activity
-- in aggregate, and none of it is a thing a browser ever needs.
--
-- Row Level Security with NO policies is the whole mechanism: a role subject
-- to RLS and matched by no policy can do nothing at all. The app is
-- unaffected because it connects as the table's owner, and an owner is not
-- subject to RLS unless FORCE is set — which is deliberately not set here,
-- because the server is the one caller that must always work.
ALTER TABLE "failures" ENABLE ROW LEVEL SECURITY;

-- Belt and braces. RLS is the guarantee; these remove the grant that
-- Supabase's default privileges hand to the client roles on a new table, so
-- the table is unreachable even if a policy is ever added by accident.
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE "failures" FROM anon';
EXCEPTION WHEN undefined_object THEN null; END $$;

DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON TABLE "failures" FROM authenticated';
EXCEPTION WHEN undefined_object THEN null; END $$;
