-- The language the render answers in.
--
-- The reply to a sentence has answered in the language it was asked in since
-- the matcher learned to; the render notes that arrive minutes later did not,
-- so a conversation that started in Arabic finished in English. The worker is
-- a separate process that never sees the sentence — it sees a plan — so the
-- language has to travel with the job.
--
-- Snapshotted onto the job at enqueue rather than read from the project's last
-- message when the job is claimed, for exactly the reason `reference_path` is:
-- a render already accepted must not change because something about the
-- project changed while it sat in the queue. Someone who types an English
-- sentence, then an Arabic one while the first is still rendering, should get
-- their first answer in English.
--
-- Defaults to 'en' so every row already in this table keeps the language it
-- was actually written in. Backfilling would be rewriting history about what
-- those renders said, which they did not.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';

COMMENT ON COLUMN jobs.language IS
  'Which language this render''s notes are written in, taken from the sentence that started it. Snapshotted at enqueue so a queued render cannot change language.';
