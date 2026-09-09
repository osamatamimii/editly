-- The second way to edit: a sentence pinned to one instant of the source.
--
-- `source_ms` is milliseconds into the file as uploaded, never into the edit.
-- A person writes a note while watching a cut version, and any change earlier
-- in that cut moves every later moment of the edited clock while moving nothing
-- in the source. Anchoring to the edit would leave every note after the first
-- change pointing at the wrong instant, silently. `zoom_punch.at` and
-- `remove_silence.protect` already read this clock.
--
-- On delete cascade: a note is about a project's source and means nothing
-- without it.
create table if not exists notes (
  id uuid primary key,
  -- text, not uuid: `projects.id` is text, and a foreign key whose type
  -- disagrees with the column it points at cannot be created.
  project_id text not null references projects (id) on delete cascade,
  user_id uuid not null,
  source_ms integer not null,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every read of this table is "this project's notes, in time order".
create index if not exists notes_project_time on notes (project_id, source_ms);

COMMENT ON TABLE notes IS
  'One sentence a person pinned to one moment of their own source. The second of the two ways to edit here: a prompt rebuilds the whole plan, a note is kept and applied on top of whatever that plan turns out to be.';
COMMENT ON COLUMN notes.source_ms IS
  'Milliseconds into the source file as uploaded, never into an edit of it. An edit''s clock moves whenever anything earlier in the video is cut, so a note anchored there would point somewhere else with nothing to say so.';
COMMENT ON COLUMN notes.text IS
  'What the person wrote, verbatim. Stored instead of the operation it produced, so a note written today is re-read through tomorrow''s vocabulary.';

-- Customer data, so the same shape every customer-data table in this schema
-- has: row-level security on, one policy naming the role the server actually
-- connects as.
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'notes' AND policyname = 'notes_app'
  ) THEN
    EXECUTE 'CREATE POLICY notes_app ON notes FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO editly_app;
