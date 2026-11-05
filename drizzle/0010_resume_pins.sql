ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "pins" jsonb DEFAULT '[]'::jsonb NOT NULL;
