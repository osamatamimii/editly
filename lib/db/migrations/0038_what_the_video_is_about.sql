-- Where the product keeps what it understood, as opposed to what it did.
--
-- Everything else in this schema is a record of an action: a render, a clip, a
-- scheduled post, a charge. This table is the first one that holds a *reading*
-- — the chapters of a video, the claims made in it, the questions asked, the
-- stretches that would hold a stranger, and the one line it should open on.
--
-- ## Why the product needed this at all
--
-- Because until now nothing in it knew what a video was about. "Give me the
-- strongest thirty seconds" was answered by speech density with a hesitation
-- penalty — a measurement of how continuously somebody was talking, which is a
-- fact about the audio and not about the content. That is why the clips come
-- out plausible and are never quite the right piece: the strongest thirty
-- seconds of a talk is where the point lands, and a point can land in a
-- sentence delivered slowly with a pause in the middle of it, which scores
-- below a fast tangent every single time.
--
-- ## One row per project, replaced in place
--
-- A project is one source video, and two readings of one video are not a
-- history worth keeping — they are an ambiguity about which one is true. So
-- `project_id` is unique, and `digest` (a fingerprint of the transcript this
-- was made from) is what says whether the stored reading is still about the
-- file that is there now. Same words, keep it; different words, make it again.
-- The file's bytes would answer neither question: a re-encode of the same
-- recording is a different file and the same material.
--
-- ## `how` is a column because the two readings are not worth the same
--
-- With a model configured, this is a reading of meaning. Without one, it is
-- derived from the *shape* of the speech: boundaries at the longest pauses,
-- questions from question marks and interrogatives, peaks from density. Both
-- produce a structure with chapters in it and the two are indistinguishable to
-- anything reading this table — so a caller would treat "the longest pause in
-- the first half" as "where the subject changed". That substitution is exactly
-- the kind this codebase keeps finding in itself, so the difference is a column
-- rather than a paragraph somewhere.
--
-- The shape path deliberately stores **no claims and no hook**: attributing a
-- statement to a person, or deciding what would hold a stranger, are judgements
-- a pause cannot make. Empty and honest beats populated and invented.

CREATE TABLE IF NOT EXISTS comprehensions (
  id               text PRIMARY KEY,
  project_id       text NOT NULL,
  user_id          uuid NOT NULL,

  -- COMPREHENSION_VERSION in the worker. A reading written by an older shape of
  -- the code is remade rather than reinterpreted.
  version          integer NOT NULL,

  -- The source length this was read against. A stored reading whose duration
  -- does not match the project's is a reading of a file that is no longer there.
  duration_seconds real,
  language         text,

  -- model | structure
  how              text NOT NULL,
  -- Which reader produced it, the way a transcript names its source.
  source           text,

  -- Of the words, not of the file. See above.
  digest           text NOT NULL,

  -- The reading itself. jsonb rather than five tables because nothing queries
  -- inside these — they are read whole, by the thing that is about to plan an
  -- edit, and a join per list would buy nothing and cost five cascades.
  chapters         jsonb NOT NULL DEFAULT '[]'::jsonb,
  claims           jsonb NOT NULL DEFAULT '[]'::jsonb,
  questions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  peaks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Null is a real answer: nothing in this video works as an opening.
  hook             jsonb,

  -- What was lost getting here, in the language the job was asked in. Same
  -- shape as jobs.notes, and the same purpose: a degradation nobody is told
  -- about is the failure this product is built against.
  notes            jsonb,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Cascades, like messages, assets and clips: a reading of a video that has
  -- been deleted is not a record of anything. Named explicitly so the schema
  -- suite can name it back — every foreign key in this database has an argument
  -- written down for why it does or does not cascade.
  CONSTRAINT comprehensions_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

COMMENT ON TABLE comprehensions IS
  'What a video is about, read once from its transcript and reused: chapters, claims, questions, peaks, hook. One row per project, replaced when the words change.';
COMMENT ON COLUMN comprehensions.how IS
  'model | structure — a reading of meaning, or one derived from the shape of the speech. Indistinguishable downstream unless it is recorded, and not worth the same.';
COMMENT ON COLUMN comprehensions.digest IS
  'Fingerprint of the transcript this reading was made from. Same words, reuse it; different words, make it again.';

-- One reading per project, and the index the cascade needs, in one object: a
-- parent delete would otherwise scan this table, which is invisible at three
-- projects and a customer complaint at thirty thousand.
CREATE UNIQUE INDEX IF NOT EXISTS comprehensions_project_id_idx ON comprehensions (project_id);

-- Customer data, so the same shape every customer-data table in this schema
-- has: row-level security on, one policy naming the role the server actually
-- connects as. A policy that protects the table from the application is not
-- protection — four migrations shipped one naming `postgres` and the reads came
-- back empty rather than failing.
ALTER TABLE comprehensions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'comprehensions' AND policyname = 'comprehensions_app'
  ) THEN
    EXECUTE 'CREATE POLICY comprehensions_app ON comprehensions FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON comprehensions TO editly_app;
