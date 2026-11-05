ALTER TABLE "profile_entries" ADD COLUMN IF NOT EXISTS "always_include" boolean DEFAULT false NOT NULL;
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "always_include" boolean DEFAULT false NOT NULL;
