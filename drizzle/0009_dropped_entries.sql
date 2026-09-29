ALTER TABLE "resumes" ADD COLUMN "dropped" jsonb DEFAULT '[]'::jsonb NOT NULL;
