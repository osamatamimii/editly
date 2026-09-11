-- The music library, and the argument it settles.
--
-- Every other table in this schema holds something a customer put there. This
-- one holds something we made: thirty-second instrumental beds, generated to
-- our own account from a fixed list of six moods.
--
-- That distinction is the whole point. For the life of this product the answer
-- to "put some music under it" was a refusal with a reason — a track we hand
-- out is a licence we bought on somebody's behalf, and the only safe track is
-- one they uploaded. The reason was right about catalogues. It does not apply
-- to audio we generated ourselves, which is ours to give away.
--
-- ## Why the table exists rather than generating per render
--
-- Generation is priced per generation. A mood is a key: the first person to
-- ask for a calm bed pays for one to be made, it lands here, and everyone
-- after is served the same file. Without this table the same thirty seconds is
-- bought again on every render, forever — about $0.04 a video, which is a
-- third of the margin on the cheapest plan. With it, the cost of the whole
-- library is bounded by moods times variants: a number in the dozens, paid
-- once.
--
-- ## bpm is nullable on purpose
--
-- It is measured from the rendered file by the same detector that refuses to
-- find a grid in a pad or a drone, not read off the generator's own claim
-- about its own output. NULL is a real answer and means: do not sync anything
-- to this file.
--
-- ## Rows are retired, never deleted
--
-- A bed that is already under somebody's published video must not change or
-- vanish. A bad variant gets `retired_at` and a new one is generated beside
-- it.

CREATE TABLE IF NOT EXISTS music_tracks (
  id          uuid PRIMARY KEY,
  mood        text NOT NULL,
  path        text NOT NULL UNIQUE,
  seconds     double precision NOT NULL,
  bpm         double precision,
  source      text NOT NULL,
  times_used  integer NOT NULL DEFAULT 0,
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The only query this table serves: the least-used live bed for one mood.
CREATE INDEX IF NOT EXISTS music_tracks_mood_idx ON music_tracks (mood, times_used);

COMMENT ON TABLE music_tracks IS
  'Beds we generated ourselves, keyed by mood and reused across customers. Not a mirror of any third-party catalogue.';
COMMENT ON COLUMN music_tracks.bpm IS
  'Measured from the file by beats.ts, never taken from the generator. NULL means no trustworthy grid: do not sync cuts to this track.';
COMMENT ON COLUMN music_tracks.retired_at IS
  'Stop handing this variant out. The file stays: renders that already used it are published.';

-- Row-level security, on a table with no owner.
--
-- Every other table here is fenced by user id. This one has no user: the beds
-- belong to the product and any customer may be served any of them, so the
-- policy is permissive by design.
--
-- It is still switched on, and that is the point. The invariant this schema
-- holds is "every table in public has RLS enabled" — not "every table needs
-- it" — because the day somebody adds a table and forgets, the failure is
-- silent and total. A table that genuinely needs no fence proves it by
-- carrying a policy that says so out loud, rather than by being the one
-- exception nobody can tell apart from a mistake.
ALTER TABLE music_tracks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'music_tracks' AND policyname = 'music_tracks_app'
  ) THEN
    EXECUTE 'CREATE POLICY music_tracks_app ON music_tracks FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON music_tracks TO editly_app;
