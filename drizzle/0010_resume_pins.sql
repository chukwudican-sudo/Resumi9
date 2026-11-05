ALTER TABLE "resumes" ADD COLUMN "pins" jsonb DEFAULT '[]'::jsonb NOT NULL;
