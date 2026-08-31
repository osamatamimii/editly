-- Fonts a person brought themselves.
--
-- The product ships thirteen faces, chosen to be different from each other,
-- and that is a good list and not the one somebody's brand uses. A studio has
-- a typeface; an agency's client has a typeface; the whole point of a caption
-- is that it looks like it came from them. So a person can upload a font, and
-- from then on it sits in the picker beside ours.
--
-- ## Why this is a table and not a folder
--
-- A font is not a file here. It is a file *plus three numbers*, and every one
-- of the three is a way to be silently wrong — the family fontconfig resolves,
-- the fraction of the line height a letter occupies, and how wide the face
-- runs against the one the layout's advance table was measured from. Get any
-- of them wrong and nothing fails: the caption draws, the words are right, and
-- it is the wrong font at the wrong size wrapping in the wrong place.
--
-- Those numbers cannot be read out of the file. They are measured by rendering
-- through libass and counting pixels, which happens once, in a worker, on the
-- machine that will burn with it — see `artifacts/worker/src/font-intake.ts`.
-- This table is where the answer is kept so that measuring happens once per
-- font rather than once per render.
--
-- ## Why there is a status
--
-- Because the measurement is a job, and because it can say no. A font that
-- draws nothing, or that resolves to the machine's fallback, or that cannot
-- draw لا, is refused with a reason a person can act on — and "your font was
-- rejected" with no reason is the thing this column exists to avoid.

CREATE TABLE IF NOT EXISTS caption_faces (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL,

  -- What the person called it, and what the file called itself. Both, because
  -- they disagree more often than not: a file named `MyBrand-Final-2.otf`
  -- announces itself as "Greta Sans Condensed", and the picker should show the
  -- second while the person searches for the first.
  label         text NOT NULL,
  declared      text,

  -- latin | arabic. Which list it appears in — and a font covering both is two
  -- rows, because the picker is per script and a caption track can carry both.
  script        text NOT NULL,

  -- The family name a style row hands to fontconfig. Ours, not the foundry's:
  -- a file calling itself "Rubik" would otherwise resolve from wherever Rubik
  -- already is on the machine, and the render would draw a font the person
  -- never uploaded.
  family        text,

  -- Where the two files are in Storage. The face is what the worker downloads
  -- and burns with; the preview is a subset the picker draws the sample in.
  --
  -- They are never put in one folder. The preview carries the same family name
  -- as the face, so side by side fontconfig indexes both and libass sometimes
  -- picks the subset — after which every character outside the sample renders
  -- as nothing at all.
  source_path   text NOT NULL,
  face_path     text,
  preview_path  text,

  -- Measured, never taken from a table in the font. Null until the job runs.
  cap_ratio     real,
  width_scale   real,

  -- pending | ready | refused
  status        text NOT NULL DEFAULT 'pending',

  -- Why it was refused, in the machine's words and in the person's. Both
  -- languages, because a refusal nobody can read is a refusal that generates a
  -- support message instead of a second upload.
  refusal_code  text,
  refusal_en    text,
  refusal_ar    text,

  bytes         integer NOT NULL DEFAULT 0,

  -- What the person said about their right to use it, recorded at upload.
  --
  -- Nothing can check this. A font file carries no machine-readable statement
  -- of what its owner permits, and a name table saying "OFL" is a string
  -- somebody typed. What the product can do is ask, keep the answer, and show
  -- it back — so that the question was asked of the person who knows.
  rights        text NOT NULL DEFAULT 'own',

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE caption_faces IS
  'Fonts a person uploaded. Holds the three measured numbers a render needs, because they are measured by rendering and cannot be read out of the file.';
COMMENT ON COLUMN caption_faces.status IS
  'pending | ready | refused — refused carries a reason in both languages, because a rejection nobody can read produces a support message rather than a second upload.';
COMMENT ON COLUMN caption_faces.rights IS
  'What the person said about their right to use this font commercially. Recorded, not verified: nothing can verify it.';

CREATE INDEX IF NOT EXISTS caption_faces_user_idx ON caption_faces (user_id, script, status);

-- One upload of the same file is one face. Pressing the button twice on the
-- same font gives one row rather than two identical entries in a picker.
CREATE UNIQUE INDEX IF NOT EXISTS caption_faces_source_idx ON caption_faces (user_id, source_path);

-- The table holds one person's fonts and nothing else may read them. Enabled
-- with no policy for anyone but the application role, which is the shape every
-- customer-data table in this schema has — and which `tools/schema-test.mjs`
-- asserts for every table in `public`, so a sixth one added next year meets
-- this rule before it ships rather than after Supabase's linter finds it.
ALTER TABLE caption_faces ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'caption_faces' AND policyname = 'caption_faces_app'
  ) THEN
    EXECUTE 'CREATE POLICY caption_faces_app ON caption_faces FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON caption_faces TO editly_app;
