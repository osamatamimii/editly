-- The words, kept, instead of bought again for every render.
--
-- A transcript is the single most expensive thing this pipeline produces. It is
-- billed by the minute of audio, it is the slowest step in a render that has a
-- customer watching a progress bar, and it is a **pure function of the sound in
-- the file** — the same audio through the same provider gives the same words.
--
-- And it was thrown away every time. Every message that asks for an edit starts
-- a render; every render with captions transcribed the source again from the
-- top. A conversation with five refinements on one thirty-minute podcast bought
-- the same half hour of speech five times, waited for it five times, and
-- discarded it five times. Nothing failed: the words were right on each of the
-- five.
--
-- It matters more now than it did. The direction no longer stands down on a
-- project it has heard nothing from — see the `hasSpeech` note in
-- `messages.ts`, and the loop that could not open before it — so captions are
-- on the *first* message rather than on the tenth, and the volume of
-- transcription this product buys went up by design. This is what keeps that
-- from being a bill.
--
-- ## What makes a stored transcript still the right one
--
-- Not the words, which is what `comprehensions` keys on — that would be
-- circular here, since the words are the thing being stored. The media.
--
-- `source_path` is the storage object the transcript was made from, and `stamp`
-- is that object's own version: its size in bytes and the moment the store last
-- wrote it, read from one HEAD request. A re-upload changes both. A different
-- file of a different length changes the first. What this cannot tell apart is
-- two different files of *identical byte length* written to the same key inside
-- the resolution of the store's timestamp, which is a shape worth naming and
-- not worth engineering around.
--
-- A content hash would be exact and costs a full read of the media — measured
-- at seven seconds for a 72 MB file on the worker's disk, and proportionally
-- worse on the four-hour sources the pricing page sells. Paying that on every
-- render to avoid paying a transcriber on some of them is the wrong trade.
--
-- ## One row per project, replaced in place
--
-- Same argument as `comprehensions` above it: a project is one source video,
-- and two transcripts of one video are not a history — they are an ambiguity
-- about which one is true.
--
-- `provider` and `version` are stored beside the words because a transcript
-- from a different model, or from an older shape of this code, is a different
-- answer that looks identical from here. Reuse requires all three to match.

CREATE TABLE IF NOT EXISTS transcripts (
  id           text PRIMARY KEY,
  project_id   text NOT NULL,
  user_id      uuid NOT NULL,

  -- TRANSCRIPT_VERSION in the worker. Words stored by an older shape of the
  -- reader are bought again rather than reinterpreted.
  version      integer NOT NULL,

  -- The storage object these words were heard from, and that object's own
  -- version. See above for why this and not a hash of the bytes.
  source_path  text NOT NULL,
  stamp        text NOT NULL,

  -- Which provider and model produced it. A transcript from another model is a
  -- different answer to the same question, and the render notes already say so.
  provider     text NOT NULL,

  -- BCP-47 as the provider reported it. Null when it reported none.
  language     text,

  -- The words themselves, whole. jsonb rather than a row per word because
  -- nothing queries inside them: they are read entire, by the thing that is
  -- about to lay out captions, and a table of a hundred thousand word rows per
  -- project would buy nothing and cost a cascade.
  segments     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- What was lost getting here, in the language the job was asked in. Same
  -- shape as `jobs.notes`, and carried forward with the words so a reused
  -- transcript still tells the customer it rested on a single reading rather
  -- than two that agree.
  notes        jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- Cascades, like the reading made from it: words belonging to a video that
  -- has been deleted are not a record of anything.
  CONSTRAINT transcripts_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

COMMENT ON TABLE transcripts IS
  'The words heard in a project''s source, kept so a second render does not buy them again. One row per project, replaced when the media changes.';
COMMENT ON COLUMN transcripts.stamp IS
  'The storage object''s own version — its byte length and the moment the store last wrote it. Same stamp, same words.';
COMMENT ON COLUMN transcripts.provider IS
  'Which model produced these words. A transcript from another model is a different answer, so reuse requires it to match.';

CREATE UNIQUE INDEX IF NOT EXISTS transcripts_project_id_idx ON transcripts (project_id);

-- Customer data, so the same shape every customer-data table in this schema
-- has: row-level security on, one policy naming the role the server actually
-- connects as.
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'transcripts' AND policyname = 'transcripts_app'
  ) THEN
    EXECUTE 'CREATE POLICY transcripts_app ON transcripts FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON transcripts TO editly_app;
