-- `scheduled_posts.attempts` was created as text.
--
-- 0032 has been corrected in place, so a database built from nothing already
-- has the right type and this file does nothing. It exists for the databases in
-- between — a machine where 0032 ran before the fix, whose migration ledger now
-- says it is applied and will never run it again. That is exactly the state
-- that is hardest to notice: the column is there, every insert works, every
-- read works, and the only symptom is that a retry ceiling written against it
-- compares '10' < '3' and is wrong in a direction nobody can see.
--
-- Written against the *observed* type rather than blindly, because ALTER on a
-- column that is already an integer would be a no-op with a table rewrite
-- attached to it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'scheduled_posts'
       AND column_name = 'attempts'
       AND data_type <> 'integer'
  ) THEN
    ALTER TABLE scheduled_posts
      ALTER COLUMN attempts DROP DEFAULT,
      ALTER COLUMN attempts TYPE integer USING COALESCE(NULLIF(attempts::text, ''), '0')::integer,
      ALTER COLUMN attempts SET DEFAULT 0;
  END IF;
END $$;
