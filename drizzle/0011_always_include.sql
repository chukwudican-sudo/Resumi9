ALTER TABLE "profile_entries" ADD COLUMN "always_include" boolean DEFAULT false NOT NULL;
ALTER TABLE "facts" ADD COLUMN "always_include" boolean DEFAULT false NOT NULL;
